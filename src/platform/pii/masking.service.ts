export function maskPhone(v: string): string {
  if (!v || v.length < 4) return v;
  const digits = v.replace(/\D/g, '');
  if (digits.length < 4) return v;
  // Keep first 2 and last 2 digits, mask the rest
  const visible = 2;
  const masked = 'X'.repeat(Math.max(0, digits.length - visible * 2));
  return digits.slice(0, visible) + masked + digits.slice(-visible);
}

export function maskEmail(v: string): string {
  if (!v || !v.includes('@')) return '***@***.***';
  const [local, domain] = v.split('@');
  const maskedLocal = local.length <= 2
    ? local[0] + '*'
    : local.slice(0, 2) + '*'.repeat(local.length - 2);
  const domainParts = domain.split('.');
  const maskedDomain = domainParts[0].length <= 1
    ? domainParts[0] + '****'
    : domainParts[0].slice(0, 1) + '*'.repeat(Math.min(4, domainParts[0].length - 1));
  const ext = domainParts.slice(1).join('.');
  return `${maskedLocal}@${maskedDomain}.${ext}`;
}

export function maskGST(v: string): string {
  if (!v || v.length < 5) return '***';
  return v.slice(0, 5) + '*'.repeat(Math.max(0, v.length - 7)) + v.slice(-2);
}

export function maskPAN(v: string): string {
  if (!v || v.length < 4) return '***';
  return v.slice(0, 5) + '*'.repeat(Math.max(0, v.length - 6)) + v.slice(-1);
}

export function maskAddress(v: string): string {
  if (!v || v.length < 8) return '*** ***';
  const words = v.trim().split(/\s+/);
  if (words.length <= 2) return '*'.repeat(v.length);
  return words.slice(0, 1).join(' ') + ' ' + '*'.repeat(Math.max(4, words.slice(1).join(' ').length));
}

export function maskGeneric(v: string): string {
  if (!v || v.length === 0) return '';
  if (v.length <= 3) return '*'.repeat(v.length);
  return v.slice(0, 1) + '*'.repeat(v.length - 2) + v.slice(-1);
}

export function maskField(fieldName: string, value: string): string {
  if (!value || typeof value !== 'string') return value;
  switch (fieldName) {
    case 'phone':
    case 'mobile':
    case 'whatsapp':
    case 'alternatePhone':
      return maskPhone(value);
    case 'email':
      return maskEmail(value);
    case 'gstin':
      return maskGST(value);
    case 'pan':
      return maskPAN(value);
    case 'address':
      return maskAddress(value);
    default:
      return maskGeneric(value);
  }
}
