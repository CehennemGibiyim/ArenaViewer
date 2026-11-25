import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  real,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Kullanıcı hesabı. `passwordHash` scrypt ile üretilir ("-" = parolasız/demo satırı).
 * İki faktörlü doğrulama için `twoFactorSecret` (TOTP gizli anahtarı, açık metin:
 * yalnızca bu sunucuda tutulur) ve `twoFactorEnabled`.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  title: text("title").notNull().default(""),
  regNo: text("reg_no").notNull().default(""),
  role: text("role").notNull().default("radyolog"), // yonetici | radyolog | teknisyen
  active: boolean("active").notNull().default(true),
  twoFactorSecret: text("two_factor_secret").notNull().default(""),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
  /** Art arda başarısız giriş sayısı (başarılı girişte sıfırlanır). */
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  /** Hesap kilidinin bitişi; null = kilitli değil. */
  lockedUntil: timestamp("locked_until"),
  /** Kurumsal kimlik bağlantısı (OIDC): veren kurum ve kimliğin kalıcı kimliği. */
  oidcIssuer: text("oidc_issuer").notNull().default(""),
  oidcSubject: text("oidc_subject").notNull().default(""),
  /** LDAP/AD bağlantısı: dizindeki ayırt edici ad (küçük harfe indirgenmiş). */
  ldapDn: text("ldap_dn").notNull().default(""),
  /** SAML bağlantısı: IdP entityID + NameID (kimliğin kalıcı eşi). */
  samlIssuer: text("saml_issuer").notNull().default(""),
  samlNameId: text("saml_name_id").notNull().default(""),
}, (t) => [
  index("users_oidc_idx").on(t.oidcIssuer, t.oidcSubject),
  index("users_ldap_idx").on(t.ldapDn),
  index("users_saml_idx").on(t.samlIssuer, t.samlNameId),
]);

/**
 * SAML tek kullanım kaydı: doğrulanmış her Assertion ID'si buraya yazılır.
 *
 * Neden DB: uygulama birden çok süreçte çalışabilir; yeniden oynatma (replay)
 * korumasının süreçler arası çalışması gerekir. `assertion_id` benzersizdir,
 * yinelenen ekleme `null` döner ve giriş reddedilir.
 */
export const samlReplay = pgTable(
  "saml_replay",
  {
    id: serial("id").primaryKey(),
    assertionId: text("assertion_id").notNull(),
    consumedAt: timestamp("consumed_at").notNull().defaultNow(),
    /** Assertion'ın son geçerlilik anı; sonrasında satır silinebilir. */
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [uniqueIndex("saml_replay_assertion_idx").on(t.assertionId), index("saml_replay_expiry_idx").on(t.expiresAt)]
);

/**
 * Sunucu tarafı oturum kaydı — "aktif oturum listesi / iptali" için.
 *
 * Oturum kimliği imzalı çerezde taşınır; burada yalnız sunucunun bildiği kayıt
 * tutulur. Çerez geçerli olsa bile kayıt iptal edilmişse (revoked_at) istek
 * kimliksiz sayılır. Böylece "oturumu kapat" gerçekten sunucuda etki eder.
 */
export const sessions = pgTable(
  "sessions",
  {
    /** 32 karakterlik rastgele hex (çerezde imzalı taşınır). */
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedBy: integer("revoked_by"),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { precision: 3 }).notNull(),
    userId: integer("user_id"),
    username: text("username").notNull().default(""),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    details: text("details").notNull().default("{}"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("audit_logs_ts_idx").on(t.ts)]
);

export const studies = pgTable("studies", {
  id: serial("id").primaryKey(),
  studyUid: text("study_uid").notNull().unique(),
  patientName: text("patient_name").notNull().default("ANONIM"), // şifreli
  patientId: text("patient_id").notNull().default("TR-000001"), // şifreli
  patientAge: text("patient_age").notNull().default("-"),
  patientSex: text("patient_sex").notNull().default("U"),
  modality: text("modality").notNull(),
  bodyPart: text("body_part").notNull(),
  studyDate: text("study_date").notNull().default(""),
  seriesDescription: text("series_description").notNull(),
  institution: text("institution").notNull().default(""),
  sliceCount: integer("slice_count").notNull().default(1),
  workStatus: text("work_status").notNull().default("bekliyor"), // bekliyor | okunuyor | taslak | onayli
  assignedTo: integer("assigned_to").references(() => users.id, { onDelete: "set null" }),
  triageLevel: text("triage_level").notNull().default(""),
  triageScore: real("triage_score").notNull().default(0),
  aiEngine: text("ai_engine").notNull().default(""),
  source: text("source").notNull().default("yerel"), // yerel | pacs | his
  accession: text("accession").notNull().default(""),
  hasFiles: boolean("has_files").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  studyId: integer("study_id")
    .notNull()
    .references(() => studies.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("taslak"),
  version: integer("version").notNull().default(1),
  mode: text("mode").notNull().default("kapsamli"),
  clinicalInfo: text("clinical_info").notNull().default(""), // şifreli
  technique: text("technique").notNull().default(""),
  findingsText: text("findings_text").notNull().default(""),
  impression: text("impression").notNull().default(""),
  recommendation: text("recommendation").notNull().default(""),
  findingsJson: jsonb("findings_json").notNull().default([]),
  findingsApproval: jsonb("findings_approval").notNull().default({}),
  triageLevel: text("triage_level").notNull().default("rutin"),
  triageScore: real("triage_score").notNull().default(0),
  aiModel: text("ai_model").notNull().default(""),
  engine: text("engine").notNull().default(""),
  modelCard: text("model_card").notNull().default(""),
  approvedBy: text("approved_by").notNull().default(""),
  doctorTitle: text("doctor_title").notNull().default(""),
  doctorRegNo: text("doctor_reg_no").notNull().default(""),
  institution: text("institution").notNull().default(""),
  approvedAt: timestamp("approved_at"),
  contentHash: text("content_hash").notNull().default(""),
  signatureMeta: text("signature_meta").notNull().default(""),
  keyImageDataUrl: text("key_image_data_url").notNull().default(""), // şifreli
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Gölge mod (shadow mode) kaydı: henüz doğrulanmamış model çıktılarının rapora
 * girilmeden toplanması. Bulgular "aday" niteliğinde kalır; değerlendirme hekim
 * onayına bağlıdır. Ayrıntı: docs/KLINIK_DOGRULAMA_PLANI.md §2.
 */
export const shadowFindings = pgTable("shadow_findings", {
  id: serial("id").primaryKey(),
  engine: text("engine").notNull(),
  model: text("model").notNull().default(""),
  studyUid: text("study_uid").notNull().default(""),
  modality: text("modality").notNull().default(""),
  findingCount: integer("finding_count").notNull().default(0),
  findingsJson: jsonb("findings_json").notNull().default([]),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const reportVersions = pgTable("report_versions", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id")
    .notNull()
    .references(() => reports.id, { onDelete: "cascade" }),
  versionNo: integer("version_no").notNull(),
  action: text("action").notNull(),
  snapshot: text("snapshot").notNull(),
  createdBy: integer("created_by"),
  createdByName: text("created_by_name").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const reportAddenda = pgTable("report_addenda", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id")
    .notNull()
    .references(() => reports.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdBy: integer("created_by"),
  createdByName: text("created_by_name").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Süreli paylaşım bağlantısı (F5): rapor/çalışma özetinin dışa açık, süreli,
 * kapatılabilir ve erişimleri denetlenen şekilde paylaşılması.
 */
export const shareLinks = pgTable("share_links", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  kind: text("kind").notNull(), // report | study
  reportId: integer("report_id").references(() => reports.id, { onDelete: "cascade" }),
  studyId: integer("study_id").references(() => studies.id, { onDelete: "cascade" }),
  createdBy: integer("created_by"),
  createdByName: text("created_by_name").notNull().default(""),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessAt: timestamp("last_access_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * İkinci okuma / peer review (D): raporun değerlendiren ikinci hekimden gelen uyum kaydı.
 * contentHash, incelemenin hangi rapor sürümüne ait olduğunu taşır.
 */
export const peerReviews = pgTable("peer_reviews", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id")
    .notNull()
    .references(() => reports.id, { onDelete: "cascade" }),
  result: text("result").notNull(), // uyumlu | kismen-uyumlu | uyumsuz
  discrepancyType: text("discrepancy_type").notNull().default(""),
  note: text("note").notNull().default(""),
  reviewedBy: integer("reviewed_by"),
  reviewedByName: text("reviewed_by_name").notNull().default(""),
  contentHash: text("content_hash").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Model kayıt defteri (a-modelops): model sürümleri, aşamaları ve A/B trafik
 * payları. Her değişiklik denetim kaydına yazılır; performans iddiası taşımaz.
 */
export const modelRegistry = pgTable(
  "model_registry",
  {
    id: serial("id").primaryKey(),
    modelKey: text("model_key").notNull(),
    version: text("version").notNull(),
    stage: text("stage").notNull().default("aday"), // aday | gölge | aktif | emekli
    trafficPct: integer("traffic_pct").notNull().default(0),
    artifactHash: text("artifact_hash").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("model_registry_uq").on(t.modelKey, t.version)],
);

/**
 * Ölçüm geçmişi (c-measure-history): hasta ve çalışma bazında yapılandırılmış
 * sayısal ölçümler (mm / mm² / mL / HU / SUV). Trend yalnız bu satırlardan
 * hesaplanır; eksik ölçüm tahmin edilmez. `label` = ölçüm türü + kullanıcı etiketi.
 */
export const measurementHistory = pgTable(
  "measurement_history",
  {
    id: serial("id").primaryKey(),
    patientId: text("patient_id").notNull(),
    studyUid: text("study_uid").notNull().default(""),
    studyDate: text("study_date").notNull().default(""),
    seriesKey: text("series_key").notNull().default(""),
    modality: text("modality").notNull().default(""),
    label: text("label").notNull(),
    kind: text("kind").notNull().default(""),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    slice: integer("slice").notNull().default(0),
    recordedBy: integer("recorded_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("measurement_history_patient_idx").on(t.patientId, t.label)],
);

/** Seri bazlı ölçüm/anotasyon ve anahtar kesitler. keyImages şifreli JSON. */
export const studyState = pgTable(
  "study_state",
  {
    id: serial("id").primaryKey(),
    studyUid: text("study_uid").notNull(),
    seriesKey: text("series_key").notNull(),
    annotations: text("annotations").notNull().default("[]"),
    keyImages: text("key_images").notNull().default(""),
    updatedBy: integer("updated_by"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("study_state_uq").on(t.studyUid, t.seriesKey)]
);

export const storedFiles = pgTable("stored_files", {
  id: serial("id").primaryKey(),
  studyId: integer("study_id")
    .notNull()
    .references(() => studies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  size: integer("size").notNull(),
  path: text("path").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Kritik bulgu bildirimi (D1) ve takip önerisi görevi (D2) tek tabloda.
 *
 * `kind` ile ayrılır; mevcut satırlar kind=NULL bırakılır ve geriye dönük olarak
 * kural tabanlı “bulgu bildirimi” sayılır. Yeni sütunların tamamı opsiyoneldir, yani
 * eski veri bozulmadan şema uygulanabilir.
 */
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  kind: text("kind"), // null | finding | followup
  severity: text("severity").notNull(),
  studyUid: text("study_uid").notNull().default(""),
  message: text("message").notNull(),
  ackBy: integer("ack_by"),
  ackByName: text("ack_by_name").notNull().default(""),
  ackAt: timestamp("ack_at"),
  /** Kapanış döngüsü: bildirimin iletildiği kişi/kanal ve kanıt zamanı. */
  relayedTo: text("relayed_to").notNull().default(""),
  relayedAt: timestamp("relayed_at"),
  escalated: boolean("escalated").notNull().default(false),
  escalatedAt: timestamp("escalated_at"),
  /** Takip önerisi alanları (D2). */
  modality: text("modality").notNull().default(""),
  bodyRegion: text("body_region").notNull().default(""),
  recommendedIntervalDays: integer("recommended_interval_days"),
  dueDate: text("due_date").notNull().default(""),
  status: text("status").notNull().default("acik"), // acik | tamamlandi | iptal
  completedAt: timestamp("completed_at"),
  reportId: integer("report_id"),
});

/**
 * Rapor şablonu. `indication` (endikasyon/klinik soru) ve `protocol` (önerilen sekans/
 * görüntüleme düzeni) alanları şablon kütüphanesinin bölge+endikasyon ekseninde
 * gruplanmasını sağlar; eski satırlar boş dize alır.
 */
export const reportTemplates = pgTable("report_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  modality: text("modality").notNull().default(""),
  bodyPart: text("body_part").notNull().default(""),
  indication: text("indication").notNull().default(""),
  protocol: text("protocol").notNull().default(""),
  technique: text("technique").notNull().default(""),
  findings: text("findings").notNull().default(""),
  impression: text("impression").notNull().default(""),
  recommendation: text("recommendation").notNull().default(""),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Kullanıcı tercihleri (F3). `prefs` JSONB, yalniz beyaz-listeli alanlar
 * (`src/lib/prefs.ts`) kabul edilir; eski kayitlar bos nesne alir.
 */
export const userPreferences = pgTable("user_preferences", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  prefs: jsonb("prefs").notNull().default({}),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

/**
 * Denetim → SIEM teslimat kuyruğu (w-audit). Her CEF olayı buraya yazılır,
 * toplayıcı erişilemezse satır kuyrukta kalır ve yeniden denenir; denetim
 * kaydının kendisi hiçbir zaman değiştirilmez.
 */
export const auditDelivery = pgTable(
  "audit_delivery",
  {
    id: serial("id").primaryKey(),
    auditId: integer("audit_id"),
    /** CEF satırı (toplayıcı/JSON olarak aynen gönderilir). */
    payload: text("payload").notNull(),
    status: text("status").notNull().default("bekliyor"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    lastAttemptAt: timestamp("last_attempt_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_delivery_status_idx").on(t.status)],
);

export type Study = typeof studies.$inferSelect;
export type Report = typeof reports.$inferSelect;
