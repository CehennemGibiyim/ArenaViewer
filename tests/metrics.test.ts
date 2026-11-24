/** Prometheus metrik biçimlendirici testleri. */
import assert from "node:assert/strict";
import { escapeLabelValue, prometheusText } from "../src/lib/server/metrics";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`PASS ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
};

ok(escapeLabelValue('a"b\\c\nd') === 'a\\"b\\\\c\\nd', "Etiket kaçışı: tırnak, ters eğik, satır sonu");

const text = prometheusText([
  { name: "atik_db_up", help: "Veritabanı 1/0", type: "gauge", points: [{ labels: {}, value: 1 }] },
  {
    name: "atik_reports_total", help: "Rapor sayısı", type: "gauge",
    points: [
      { labels: { status: "taslak" }, value: 3 },
      { labels: { status: "onaylandi" }, value: 7 },
    ],
  },
]);
ok(text.includes("# HELP atik_db_up Veritabanı 1/0"), "HELP satırı");
ok(text.includes("# TYPE atik_reports_total gauge"), "TYPE satırı");
ok(text.includes("atik_db_up 1\n"), "Etiketsiz nokta");
const coklu = prometheusText([{ name: "m", help: "h", type: "gauge", points: [{ labels: { z: "1", a: "2" }, value: 1 }] }]);
ok(coklu.includes('{a="2",z="1"}'), "Bir noktadaki etiketler alfabetik sıralanır");
ok(text.includes("atik_reports_total{status=\"onaylandi\"} 7"), "Etiketli nokta");
ok(prometheusText([{ name: "x", help: "h", type: "counter", points: [{ labels: { a: "1" }, value: Number.POSITIVE_INFINITY }] }]).includes(" x{a=\"1\"} NaN\n".trim()), "Sayılmaz değer NaN");
ok(prometheusText([{ name: "x", help: "h", type: "counter", points: [{ labels: { a: "1" }, value: 2.5 }] }]).includes('x{a="1"} 2.5'), "Ondalık değer");

if (failed) { console.error(`${failed} metrik testi başarısız`); process.exit(1); }
console.log("Tüm metrik biçimlendirme testleri geçti.");
