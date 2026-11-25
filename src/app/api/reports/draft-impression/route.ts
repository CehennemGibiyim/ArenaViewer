import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { authorize } from "@/lib/server/auth";
import { buildStyleInstruction } from "@/lib/styleProfile";
import {
  buildDraftPrompt,
  DRAFT_SYSTEM_PROMPT,
  finalizeDraft,
  identityLeaks,
  verifiedFindings,
  type DraftFinding,
} from "@/lib/genaiDraft";

export const dynamic = "force-dynamic";

interface DraftBody {
  modality: string;
  bodyPart: string;
  /** Hekimin geçmiş (kimliksiz) rapor metninden alınmış üslup örneği. */
  styleSample?: string;
  findings: { label: string; detail: string; slice: number; category: string; severity: string; status: string }[];
}

/**
 * İzlenim taslağı. LLM_API_URL + LLM_API_KEY (OpenAI uyumlu) tanımlıysa LLM kullanılır; değilse kural tabanlı üretilir.
 * Yalnızca hekimin doğruladığı/düzenlediği bulgular gönderilir; hasta adı/kimliği ASLA gönderilmez.
 */
export async function POST(req: NextRequest) {
  const a = await authorize(req, ["radyolog", "yonetici"]);
  if ("error" in a) return a.error;
  const b = (await req.json().catch(() => null)) as DraftBody | null;
  const verified = verifiedFindings((b?.findings ?? []) as DraftFinding[]);
  if (!b || verified.length === 0) return NextResponse.json({ error: "Önce en az bir bulguyu 'Onayla/Düzenlendi' olarak işaretleyin" }, { status: 400 });
  // Üslup örneği kimlik içeriyorsa hiç gönderilmez (savunma katmanı).
  const hamOrnek = (b.styleSample ?? "").trim().slice(0, 1200);
  const styleSample = identityLeaks(hamOrnek).length ? "" : hamOrnek;
  const url = process.env.LLM_API_URL;
  const key = process.env.LLM_API_KEY;
  let llmText: string | null = null;

  const styleInstruction = styleSample ? buildStyleInstruction(styleSample) : null;
  if (url && key) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          model: process.env.LLM_MODEL ?? "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: DRAFT_SYSTEM_PROMPT },
            { role: "user", content: buildDraftPrompt({ modality: b.modality, bodyPart: b.bodyPart, findings: verified }) },
            ...(styleInstruction ? [{ role: "system" as const, content: styleInstruction }] : []),
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        llmText = data.choices?.[0]?.message?.content?.trim() || null;
      }
    } catch {
      /* kural tabanlı yedeğe düş */
    }
  }
  // Doğrulama: sayı/kesit uydurması ve kimlik sızması denetlenir; başarısızsa
  // kural tabanlı metin kullanılır ve gerekçe yanıtla birlikte döner.
  const result = finalizeDraft(llmText, verified);
  const { text, source } = result;
  await audit(a.user, "report.draft_impression", "report", "", {
    source,
    findings: verified.length,
    reason: result.reason,
    styleSample: !!styleSample,
    rejected: !!result.rejected,
  });
  return NextResponse.json({ text, source, reason: result.reason, rejected: result.rejected });
}
