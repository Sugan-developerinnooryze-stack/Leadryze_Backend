export interface PIIFieldDef {
  level2: string[];  // Sensitive — phone, email, address, GST, PAN
  level3: string[];  // Highly sensitive — bank, government IDs
}

export const PII_FIELDS: Record<string, PIIFieldDef> = {
  customers: {
    level2: ['phone', 'mobile', 'email', 'address', 'website', 'gstin', 'pan'],
    level3: [],
  },
  leads: {
    level2: ['phone', 'mobile', 'email', 'address', 'whatsapp', 'alternatePhone'],
    level3: [],
  },
  contacts: {
    level2: ['phone', 'mobile', 'email'],
    level3: [],
  },
  staffs: {
    level2: ['phone', 'email'],
    level3: [],
  },
  sites: {
    level2: ['address', 'phone'],
    level3: [],
  },
};

// Roles that always see full PII regardless of piiConfig
export const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];

// Human-readable label + protected field list for the frontend Permission tab
export const PII_MODULES = [
  { key: 'customers', label: 'Customers', fields: 'Phone, Email, Address, GST, PAN' },
  { key: 'leads',     label: 'Leads',     fields: 'Phone, Email, Address, WhatsApp' },
  { key: 'contacts',  label: 'Contacts',  fields: 'Phone, Email' },
  { key: 'staffs',    label: 'Staff',     fields: 'Phone, Email' },
  { key: 'sites',     label: 'Sites',     fields: 'Address, Phone' },
];
