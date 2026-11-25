/** `scripts/supplychain.mjs` için tip bildirimi (test ve CI betikleri kullanır). */
export declare function sha256File(file: string): string;
export declare function parseSums(text: string): { digest: string; file: string }[];
export declare function buildSums(dir: string, files?: string[]): string;
export declare function checkSbom(sbom: unknown): { errors: string[]; warns: string[] };
export declare function checkProvenance(prov: unknown, digestOf: (name: string) => string | null): { errors: string[]; warns: string[] };
