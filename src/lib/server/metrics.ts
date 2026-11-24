/**
 * Prometheus metrik biçimlendirici (saf fonksiyon; test edilebilir).
 *
 * Toplanan metrikler yalnizca **toplam sayımlardan** oluşur; hasta kimliği,
 * rapor metni gibi kişisel veri içermez. Metrik tanımı Prometheus metin formatı
 * 0.0.4 ile uyumludur.
 */

export interface MetricPoint {
  labels: Record<string, string>;
  value: number;
}

export interface MetricSeries {
  name: string;
  help: string;
  /** counter | gauge | histogram */
  type: "counter" | "gauge" | "histogram";
  points: MetricPoint[];
}

/** Prometheus etiket değeri kaçışları: ters eğik çizgi, tırnak ve satır sonu. */
export function escapeLabelValue(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return "";
  return `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",")}}`;
}

/** Serileri Prometheus metin çıktısına çevirir. */
export function prometheusText(series: MetricSeries[]): string {
  const out: string[] = [];
  for (const s of series) {
    out.push(`# HELP ${s.name} ${s.help}`);
    out.push(`# TYPE ${s.name} ${s.type}`);
    for (const p of s.points) {
      out.push(`${s.name}${renderLabels(p.labels)} ${formatNumber(p.value)}`);
    }
  }
  return out.join("\n") + "\n";
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return "NaN";
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
}
