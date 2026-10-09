export interface Clinic {
  id: number;
  name_en: string;
  name_ar: string;
  phone: string;
  email: string;
  address_en: string;
  address_ar: string;
  currency: string;
  default_language: "en" | "ar";
  tooth_numbering: string;
  tax_registration_number: string;
  commercial_register: string;
  tax_rate: string;
  updated_at: string;
}

export interface Me {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  language: "en" | "ar";
  clinic: Clinic | null;
  roles: { id: number; code: string; name_en: string; name_ar: string }[];
  permissions: Record<string, string[]>;
  staff_member: { id: number; staff_type: string } | null;
}

export interface Role {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  permissions: Record<string, string[]>;
  is_system: boolean;
  user_count: number;
}

export interface MetaInfo {
  modules: { code: string; name: string }[];
  actions: string[];
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  user: number | null;
  user_name: string | null;
  action: "create" | "update" | "delete";
  record_type: string;
  object_id: string;
  object_repr: string;
  changes: Record<string, [unknown, unknown]>;
}

export interface Named {
  id: number;
  name_en: string;
  name_ar: string;
}

export interface Branch extends Named {
  is_active: boolean;
}

export interface Chair extends Named {
  branch: number;
  is_active: boolean;
  sort_order: number;
}

export interface WorkingHours {
  id: number;
  branch: number;
  weekday: number;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
}

export interface StaffMember extends Named {
  staff_type: string;
  color: string;
  branches: number[];
  is_active: boolean;
}

export interface Procedure extends Named {
  code: string;
  default_duration_minutes: number;
  default_price: string;
  needs_lab: boolean;
  is_active: boolean;
}

export interface Alert {
  id: number;
  kind: string;
  text: string;
  guidance: string;
}

export interface Patient {
  id: number;
  file_number: string;
  name_ar: string;
  name_en: string;
  gender: string;
  date_of_birth: string | null;
  age: number | null;
  phone: string;
  phone_alt: string;
  whatsapp_opt_in: boolean;
  language: "ar" | "en";
  email: string;
  national_id: string;
  address: string;
  occupation: string;
  referral_source: string;
  home_branch: number | null;
  preferred_dentist: number | null;
  notes: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  insurance: string;
  is_active: boolean;
  alerts: Alert[];
  created_at: string;
}

export type AppointmentStatus = "booked" | "confirmed" | "arrived" | "in_chair" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: number;
  patient: number;
  patient_name: { ar: string; en: string };
  patient_file_number: string;
  patient_phone: string;
  patient_alerts: string[];
  dentist: number;
  dentist_name_ar: string;
  dentist_name_en: string;
  dentist_color: string;
  branch: number;
  chair: number | null;
  procedure: number | null;
  procedure_name_ar: string;
  procedure_name_en: string;
  start: string;
  duration_minutes: number;
  end: string;
  status: AppointmentStatus;
  reason: string;
  notes: string;
  cancel_reason: string;
  arrived_at: string | null;
  seated_at: string | null;
  completed_at: string | null;
  reminder_sent_at: string | null;
}

/** Next steps offered for each status (mirrors Appointment.TRANSITIONS on the server). */
export const NEXT_STATUS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ["confirmed", "arrived", "cancelled", "no_show"],
  confirmed: ["arrived", "cancelled", "no_show", "booked"],
  arrived: ["in_chair", "booked", "cancelled"],
  in_chair: ["completed", "arrived"],
  completed: ["in_chair"],
  cancelled: ["booked"],
  no_show: ["booked"],
};

// Phase 2: clinical records
export type Surface = "M" | "D" | "O" | "B" | "L";
export type SurfaceState = "sound" | "caries" | "filling" | "rct";

export interface ToothRecord {
  id?: number;
  patient: number;
  tooth: number;
  missing: boolean;
  crown: boolean;
  implant: boolean;
  root_canal_treated: boolean;
  surfaces: Partial<Record<Surface, SurfaceState>>;
  note: string;
  updated_at?: string;
}

export type PlanStatus = "proposed" | "accepted" | "in_progress" | "completed" | "cancelled";
export type LineStatus = "planned" | "in_progress" | "done" | "cancelled";
export interface PatientInfo { id: number; ar: string; en: string; file_number: string }

export interface PlanLine {
  id: number;
  plan: number;
  procedure: number;
  procedure_code: string;
  procedure_name_en: string;
  procedure_name_ar: string;
  needs_lab: boolean;
  tooth: number | null;
  surfaces: string;
  price: string;
  discount: string;
  net: string;
  status: LineStatus;
  sort_order: number;
  notes: string;
  appointment: number | null;
  appointment_start: string | null;
  completed_at: string | null;
}

export interface TreatmentPlan {
  id: number;
  patient: number;
  patient_info: PatientInfo;
  dentist: number;
  dentist_name: { ar: string; en: string } | null;
  title: string;
  status: PlanStatus;
  notes: string;
  accepted_at: string | null;
  lines: PlanLine[];
  totals: { done: string; in_progress: string; planned: string; total: string; count: number; done_count: number };
  created_at: string;
}

export interface VisitNote {
  id: number;
  patient: number;
  patient_info: PatientInfo;
  appointment: number | null;
  dentist: number;
  dentist_name: { ar: string; en: string } | null;
  visit_date: string;
  complaint: string;
  findings: string;
  work_done: string;
  next_step: string;
  lines: number[];
  signed_at: string | null;
  signed_by_name: string;
  created_at: string;
}

export interface RxItem { drug: string; dose: string; frequency: string; duration: string; notes: string }
export interface Prescription {
  id: number;
  patient: number;
  dentist: number;
  dentist_name: { ar: string; en: string } | null;
  visit_note: number | null;
  items: RxItem[];
  notes: string;
  created_at: string;
}

export interface ConsentTemplate { id: number; title_en: string; title_ar: string; body_en: string; body_ar: string; is_active: boolean }
export interface PatientConsent {
  id: number;
  patient: number;
  template: number | null;
  plan_line: number | null;
  language: "ar" | "en";
  title: string;
  body: string;
  signer_name: string;
  signer_relation: string;
  signature: string;
  signed_at: string | null;
  created_at: string;
}

// Phase 3: billing
export type PayMethod = "cash" | "instapay" | "card" | "wallet" | "bank";
export interface BillingPatient { id: number; ar: string; en: string; file_number: string; phone: string }
export interface InvoiceLine {
  id: number;
  plan_line: number | null;
  procedure: number | null;
  dentist: number | null;
  dentist_name: { ar: string; en: string } | null;
  description: string;
  tooth: number | null;
  quantity: number;
  unit_price: string;
  discount: string;
  total: string;
}
export interface Installment {
  id: number;
  invoice: number;
  invoice_number: string;
  patient_info: BillingPatient;
  number: number;
  due_date: string;
  amount: string;
  paid: string;
  remaining: string;
  status: "paid" | "overdue" | "partly_paid" | "due";
}
export interface Invoice {
  id: number;
  number: string;
  patient: number;
  patient_info: BillingPatient;
  branch: number | null;
  issue_date: string;
  status: "issued" | "void";
  payment_status: "unpaid" | "partly_paid" | "paid" | "void";
  discount: string;
  tax_rate: string;
  notes: string;
  void_reason: string;
  voided_at: string | null;
  lines: InvoiceLine[];
  installments: Installment[];
  totals: { subtotal: string; tax: string; total: string; paid: string; balance: string };
  created_at: string;
}
export interface Payment {
  id: number;
  receipt_number: string;
  patient: number;
  patient_info: BillingPatient;
  invoice: number | null;
  invoice_number: string;
  installment: number | null;
  installment_number: number | null;
  branch: number | null;
  paid_on: string;
  amount: string;
  method: PayMethod;
  reference: string;
  notes: string;
  voided_at: string | null;
  void_reason: string;
  received_by: string;
  created_at: string;
}
export interface BillableLine {
  id: number;
  plan_title: string;
  procedure_name_en: string;
  procedure_name_ar: string;
  tooth: number | null;
  surfaces: string;
  status: string;
  net: string;
  dentist: { ar: string; en: string };
}
export interface CashboxClosing {
  id: number;
  branch: number | null;
  date: string;
  totals: Record<string, string>;
  payment_count: number;
  expected_cash: string;
  counted_cash: string;
  difference: string;
  notes: string;
  closed_by: string;
  created_at: string;
}
export interface Cashbox {
  date: string;
  branch: number | null;
  totals: Record<string, string>;
  total: string;
  expected_cash: string;
  payments: Payment[];
  voided: Payment[];
  closing: CashboxClosing | null;
}
export interface CommissionRow {
  dentist: number;
  name: { ar: string; en: string };
  rule: string;
  value: string;
  billed: string;
  collected: string;
  procedures: number;
  commission: string;
}
export interface PatientAccount { billed: string; paid: string; balance: string; on_account: string }

// ---- Lab (phase 4) ----

export type LabStage = "received" | "design" | "milling" | "finishing" | "qc" | "ready" | "delivered";

export interface LabEvent {
  id: number;
  stage: LabStage;
  note: string;
  created_at: string;
  by: string;
}

export interface LabCase {
  id: number;
  number: string;
  patient: number;
  patient_info: { id: number; ar: string; en: string; file_number: string };
  plan_line: number;
  procedure: { en: string; ar: string; tooth: number | null; status: string } | null;
  dentist: number;
  dentist_name: { id: number; ar: string; en: string };
  technician: number | null;
  technician_name: { id: number; ar: string; en: string } | null;
  restoration: string;
  material: string;
  shade: string;
  teeth: string;
  units: number;
  instructions: string;
  due_date: string;
  appointment: number | null;
  appointment_start: string | null;
  stage: LabStage;
  events: LabEvent[];
  is_open: boolean;
  overdue: boolean;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  remake_of: number | null;
  remake_of_number: string | null;
  remake_numbers: string[];
  remake_reason: string;
  remake_note: string;
  remake_charged_to: string;
  material_cost: string;
  labour_cost: string;
  cost_total: string;
  cost_per_unit: string;
  created_at: string;
  priority: "normal" | "rush";
  pan_number: string;
  on_hold: boolean;
  hold_reason: string;
  shade_guide: string;
  stump_shade: string;
  cervical_shade: string;
  incisal_shade: string;
  margin: string;
  contacts: string;
  occlusion: string;
  pontic: string;
  implant_system: string;
  implant_platform: string;
  abutment: string;
  retention: string;
  enclosures: string[];
  outsourced_to: string;
  outsource_tracking: string;
}

export interface OrderableLine {
  id: number;
  procedure_name_en: string;
  procedure_name_ar: string;
  needs_lab: boolean;
  tooth: number | null;
  status: string;
  dentist: number;
  appointment: number | null;
  appointment_start: string | null;
  has_open_case: boolean;
  restoration: string;
  material: string;
}

export interface LabSummary {
  by_stage: Record<string, number>;
  open: number;
  overdue: number;
  due_today: number;
  unassigned: number;
  mine: number;
  attention: number;
  due_tomorrow: number;
  rush: number;
  on_hold: number;
  outsourced: number;
}

export interface LabDashboard {
  start: string;
  end: string;
  created: number;
  delivered: number;
  units: number;
  avg_days: number | null;
  on_time: number | null;
  remakes: number;
  remake_rate: number;
  remake_reasons: { reason: string; label: string; count: number }[];
  remakes_lab: number;
  remakes_clinic: number;
  turnaround: { restoration: string; label: string; cases: number; avg_days: number }[];
  technicians: { id: number; name: { ar: string; en: string }; open: number; delivered: number; units: number; avg_days: number | null }[];
  weeks: { week: string; in: number; out: number }[];
  by_restoration: { restoration: string; label: string; count: number }[];
  outsourced: number;
  costs: null | {
    total: string;
    per_unit: string;
    remake_cost: string;
    by_material: { material: string; label: string; cases: number; units: number; cost: string; per_unit: string }[];
  };
}

export interface LabCostRow {
  restoration: string;
  material: string;
  cases: number;
  units: number;
  cost: string;
  cost_per_unit: string;
  remakes: number;
  scrap_cost: string;
}

export interface LabCostReport {
  rows: LabCostRow[];
  delivered: number;
  remakes: number;
  remake_rate: number;
  on_time: number | null;
}

export interface FinanceDashboard {
  start: string;
  end: string;
  bucket: "day" | "week" | "month";
  now: { today: string; month: string; outstanding: string; overdue_installments: string; overdue_count: number };
  billed: string;
  collected: string;
  billed_prev: string;
  collected_prev: string;
  invoice_count: number;
  payment_count: number;
  average_invoice: string;
  discounts: string;
  collection_rate: number | null;
  trend: { period: string; billed: string; collected: string }[];
  by_method: { method: string; total: string; count: number }[];
  by_dentist: { id: number; name: { ar: string; en: string }; billed: string; collected: string }[];
  by_procedure: { code: string; name: { ar: string; en: string }; count: number; billed: string }[];
  aging: { "0_30": string; "31_60": string; "61_90": string; "90_plus": string };
  top_debtors: { id: number; ar: string; en: string; file_number: string; balance: string; oldest: string }[];
  installments_due: { id: number; invoice: number; invoice_number: string; due_date: string; remaining: string; overdue: boolean; patient: { id: number; ar: string; en: string; file_number: string } }[];
  installments_upcoming_total: string;
}
