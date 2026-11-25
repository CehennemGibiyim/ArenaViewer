import net from "node:net";
import tls from "node:tls";
import {
  bindRequest,
  ldapMessage,
  parseFilter,
  readTlv,
  resultCode,
  resultDiagnostic,
  searchRequest,
  toEntry,
  toMessage,
  type LdapEntry,
  type LdapMessage,
} from "./ldap";

/**
 * LDAP soket istemcisi: bağlan, bind et, ara.
 *
 * Tek iş parçacıklı ve sıralı kullanım için tasarlandı (giriş akışı bir kullanıcı
 * için tek bağlantı açar). TCP parçaları BER uzunluğuna göre birleştirilir;
 * zaman aşımında soket kapatılır ve bekleyen sözler reddedilir.
 */
interface Waiter {
  stop: number[];
  acc: LdapMessage[];
  resolve: (m: LdapMessage[]) => void;
  reject: (e: Error) => void;
}

export class LdapConnection {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buf = Buffer.alloc(0);
  private waiters: Waiter[] = [];
  private idSeq = 0;
  private failure: Error | null = null;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number
  ) {}

  connect(): Promise<void> {
    const u = new URL(this.url);
    const secure = u.protocol === "ldaps:";
    const port = Number(u.port || (secure ? 636 : 389));
    const host = u.hostname;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ready = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const failOnce = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
        this.fail(e);
      };
      const sock = secure
        ? tls.connect({ host, port, servername: host }, ready)
        : net.connect({ host, port }, ready);
      this.socket = sock;
      sock.setTimeout(this.timeoutMs, () => {
        failOnce(new Error("LDAP zaman aşımı"));
      });
      sock.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump();
      });
      sock.on("error", (e: Error) => failOnce(e));
      sock.on("close", () => failOnce(new Error("LDAP bağlantısı kapandı")));
    });
  }

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(e);
    this.socket?.destroy();
  }

  private pump(): void {
    for (;;) {
      const r = readTlv(this.buf, 0);
      if (!r) return;
      this.buf = this.buf.subarray(r.next);
      const msg = toMessage(r.node);
      if (!msg) continue;
      const w = this.waiters[0];
      if (!w) continue;
      w.acc.push(msg);
      if (w.stop.includes(msg.opTag)) {
        this.waiters.shift();
        w.resolve(w.acc);
      }
    }
  }

  private wait(stop: number[]): Promise<LdapMessage[]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<LdapMessage[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("LDAP yanıtı zaman aşımına uğradı"));
      }, this.timeoutMs);
      this.waiters.push({
        stop,
        acc: [],
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private send(op: Buffer): void {
    if (!this.socket || this.failure) throw this.failure ?? new Error("LDAP bağlantısı yok");
    this.socket.write(op);
  }

  /** Simple bind; 0 başarı. */
  async bind(dn: string, password: string): Promise<{ code: number; diagnostic: string }> {
    this.idSeq += 1;
    this.send(ldapMessage(this.idSeq, bindRequest(dn, password)));
    const [res] = await this.wait([0x61]);
    return { code: resultCode(res.op), diagnostic: resultDiagnostic(res.op) };
  }

  /** Alt ağaç araması; sonuç kodunu ve kayıtları döndürür. */
  async search(opts: { base: string; filter: string; attributes: string[] }): Promise<{ code: number; entries: LdapEntry[]; diagnostic: string }> {
    this.idSeq += 1;
    this.send(ldapMessage(this.idSeq, searchRequest(opts.base, parseFilter(opts.filter), opts.attributes)));
    const msgs = await this.wait([0x65]);
    const done = msgs[msgs.length - 1];
    const entries = msgs.map((m) => toEntry(m.op)).filter((e): e is LdapEntry => !!e);
    return { code: resultCode(done.op), entries, diagnostic: resultDiagnostic(done.op) };
  }

  close(): void {
    try {
      this.socket?.end();
    } catch {
      /* yoksay */
    }
    this.socket?.destroy();
    this.socket = null;
  }
}
