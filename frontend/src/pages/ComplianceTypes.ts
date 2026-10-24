// Types for phase 8: compliance (sterilisation, equipment, licences), e-invoicing and online booking.

export type Named = { id: number; en: string; ar: string } | null;
export type PatientInfo = { id: number; ar: string; en: string; file_number: string; phone: string };

export interface ComplianceSummary {
  cycles_today?: number;
  failed_cycles?: number;
  failed_unreviewed?: number;
  bi_pending?: number;
  maintenance_overdue?: number;
  maintenance_due_soon?: number;
  equipment_down?: number;
  open_work_orders?: number;
  licences_expiring?: number;
  einvoice_ready?: number;
  einvoice_pending?: number;
  einvoice_invalid?: number;
  einvoice_draft?: number;
  online_waiting?: number;
}

export interface Equipment {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  category: string;
  branch: number | null;
  branch_name: Named;
  chair: number | null;
  chair_name: Named;
  manufacturer: string;
  model_name: string;
  serial_number: string;
  supplier: number | null;
  supplier_name: string;
  purchase_date: string | null;
  cost: string;
  warranty_end: string | null;
  warranty_active: boolean;
  status: "in_service" | "out_of_service" | "retired";
  cycles_before: number;
  cycle_count: number | null;
  open_work_orders: number;
  notes: string;
}

export interface EquipmentInfo {
  id: number;
  code: string;
  en: string;
  ar: string;
  category: string;
  status: string;
  branch: Named;
}

export interface MaintenancePlan {
  id: number;
  equipment: number;
  equipment_info: EquipmentInfo;
  title_en: string;
  title_ar: string;
  kind: string;
  every_months: number | null;
  every_days: number | null;
  every_cycles: number | null;
  start_on: string;
  last_done_on: string | null;
  last_done_cycles: number | null;
  vendor: string;
  is_active: boolean;
  due: { date: string | null; cycles_left: number | null; state: "overdue" | "due_soon" | "ok" };
}

export interface WorkOrderPart {
  id: number;
  item: number;
  item_name: Named;
  unit: string;
  branch: number;
  quantity: string;
  cost: string;
  created_at: string;
}

export interface WorkOrder {
  id: number;
  number: string;
  equipment: number;
  equipment_info: EquipmentInfo;
  kind: string;
  plan: number | null;
  reported_by_name: string;
  reported_at: string;
  issue: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "waiting_parts" | "done" | "cancelled";
  takes_out_of_service: boolean;
  assigned_to: string;
  supplier: number | null;
  labour_cost: string;
  completed_at: string | null;
  resolution: string;
  parts: WorkOrderPart[];
  parts_cost: string;
  total_cost: string;
  downtime_hours: number;
}

export interface MaintenanceRecord {
  id: number;
  equipment: number;
  equipment_info: { id: number; code: string; en: string; ar: string };
  plan_title: { en: string; ar: string } | null;
  work_order_number: string;
  done_on: string;
  performed_by: string;
  cost: string;
  cycle_count: number | null;
  notes: string;
}

export interface Licence {
  id: number;
  kind: string;
  title_en: string;
  title_ar: string;
  branch: number | null;
  branch_name: Named;
  equipment: number | null;
  equipment_name: Named;
  staff: number | null;
  staff_name: Named;
  reference: string;
  authority: string;
  issued_on: string | null;
  expires_on: string;
  last_reading_msv: string | null;
  notes: string;
  state: "ok" | "expiring" | "expired";
  days_left: number;
}

export type PackState = "sterile" | "expired" | "used" | "failed" | "none";

export interface Pack {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  kind: string;
  branch: number | null;
  branch_name: Named;
  contents: string;
  is_active: boolean;
  state: PackState;
  last: {
    cycle: number;
    cycle_number: number;
    machine: string;
    sterilised_at: string;
    expires_on: string;
    used_at: string | null;
    patient: PatientInfo | null;
  } | null;
}

export interface Load {
  id: number;
  pack: { id: number; code: string; en: string; ar: string; kind: string };
  expires_on: string;
  used_at: string | null;
  patient: PatientInfo | null;
  appointment: { id: number; start: string; dentist: Named } | null;
  recall_contacted_at: string | null;
  recall_note: string;
  cycle_number?: number;
}

export interface Cycle {
  id: number;
  machine: number;
  machine_name: Named;
  branch: number | null;
  cycle_number: number;
  started_at: string;
  program: string;
  temperature: string | null;
  pressure: string | null;
  hold_minutes: number | null;
  duration_minutes: number | null;
  operator: number | null;
  operator_name: Named;
  air_removal_test: string;
  air_removal_result: string;
  chemical_indicator: string;
  bi_used: boolean;
  bi_lot: string;
  bi_result: "" | "pending" | "negative" | "positive";
  bi_read_at: string | null;
  result: "pass" | "fail";
  failure_reasons: string[];
  notes: string;
  pack_count: number;
  used_count: number;
  loads?: Load[];
}

export interface TraceRow extends Load {
  cycle: { id: number; number: number; machine: Named; program: string; started_at: string; result: string; operator: Named; bi_result: string };
}

export interface Checklist {
  id: number;
  branch: number;
  date: string;
  items: Record<string, boolean>;
  done_by: number | null;
  done_by_name: Named;
  notes: string;
}

export interface ComplianceDashboard {
  start: string;
  end: string;
  cycles: number;
  failed: number;
  pass_rate: number | null;
  packs: number;
  packs_used: number;
  bi_runs: number;
  maintenance_done: number;
  maintenance_overdue: number;
  on_time_rate: number | null;
  maintenance_cost: string;
  downtime_hours: number;
  work_orders: number;
  months: { month: string; cycles: number; failed: number; packs: number; maintenance_cost: string; downtime: number }[];
  machines: { id: number; name: Named; cycles: number; failed: number }[];
  by_category: { category: string; orders: number; downtime: number }[];
}

export type EStatus = "draft" | "ready" | "submitted" | "valid" | "invalid" | "rejected" | "cancelled";

export interface EDocument {
  id: number;
  invoice: number;
  invoice_info: { id: number; number: string; issue_date: string; status: string; patient: PatientInfo; branch: Named };
  status: EStatus;
  errors: string[];
  receiver_type: string;
  total_amount: string;
  tax_amount: string;
  uuid: string;
  long_id: string;
  submission_id: string;
  simulated: boolean;
  attempts: number;
  prepared_at: string | null;
  submitted_at: string | null;
  validated_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  url: string;
  needs_cancel: boolean;
  payload?: Record<string, unknown>;
}

export interface EInvoiceSettings {
  is_registered: boolean;
  mode: "simulation" | "live";
  environment: "preprod" | "prod";
  rin: string;
  issuer_name: string;
  activity_code: string;
  default_tax_rate: string;
  exempt_subtype: string;
  taxed_subtype: string;
  person_id_threshold: string;
  start_date: string | null;
  default_item_type: string;
  default_item_code: string;
  governate: string;
  region_city: string;
  street: string;
  building_number: string;
  postal_code: string;
  client_id: string;
  client_secret?: string;
  has_secret: boolean;
  signer_url: string;
  live_ready: boolean;
  branches: { branch: number; branch_name: Named; branch_code: string; governate: string; region_city: string; street: string; building_number: string; postal_code: string }[];
}

export interface ItemCodeRow {
  procedure: number;
  code: string;
  name: Named;
  category: Named;
  active: boolean;
  item_type: string;
  item_code: string;
  unit_type: string;
}

export interface BookingSettings {
  enabled: boolean;
  slug: string | null;
  days_ahead: number;
  min_notice_hours: number;
  slot_minutes: number;
  allow_dentist_choice: boolean;
  message_en: string;
  message_ar: string;
  services: number[];
  branches: number[];
  link: string;
}

export interface BookingRequest {
  id: number;
  reference: string;
  branch: number;
  branch_name: Named;
  procedure: number | null;
  procedure_name: Named;
  dentist: number | null;
  dentist_name: Named;
  dentist_chosen: boolean;
  start: string;
  end: string;
  duration_minutes: number;
  name: string;
  phone: string;
  note: string;
  language: string;
  status: "pending" | "confirmed" | "rejected" | "expired";
  patient: number | null;
  patient_info: PatientInfo | null;
  known_patient: PatientInfo | null;
  appointment: number | null;
  decided_by_name: string;
  decided_at: string | null;
  reject_reason: string;
  created_at: string;
}

export interface PublicClinic {
  clinic: { en: string; ar: string; phone: string };
  message: { en: string; ar: string };
  branches: { id: number; en: string; ar: string; address: { en: string; ar: string }; phone: string; hours: { weekday: number; closed: boolean; opens: string | null; closes: string | null }[] }[];
  services: { id: number; en: string; ar: string; minutes: number }[];
  dentists: { id: number; en: string; ar: string; branches: number[] }[];
  days_ahead: number;
  today: string;
}
