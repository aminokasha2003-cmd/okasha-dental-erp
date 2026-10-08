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
