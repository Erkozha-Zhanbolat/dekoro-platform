import type { CustomerSource, CustomerType } from "@/types/database";

export type CustomerDetailsFormValues = {
  display_name: string;
  legal_name: string;
  phone: string;
  email: string;
  iin_bin: string;
  contact_person: string;
  address: string;
  city: string;
  source: CustomerSource;
  notes: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase. Empty → "". */
export function normalizeCustomerEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Conservative phone normalize: trim and collapse internal whitespace.
 * Does not rewrite country codes or strip punctuation.
 */
export function normalizeCustomerPhone(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function emptyCustomerDetailsForm(
  source: CustomerSource = "staff",
): CustomerDetailsFormValues {
  return {
    display_name: "",
    legal_name: "",
    phone: "",
    email: "",
    iin_bin: "",
    contact_person: "",
    address: "",
    city: "",
    source,
    notes: "",
  };
}

export function validateCustomerDetailsForm(
  customerType: CustomerType,
  values: CustomerDetailsFormValues,
): string | null {
  const phone = normalizeCustomerPhone(values.phone);
  const email = normalizeCustomerEmail(values.email);

  if (customerType === "individual") {
    if (!values.display_name.trim()) {
      return "Укажите ФИО";
    }
    if (!phone) {
      return "Укажите телефон";
    }
    if (!email) {
      return "Укажите email";
    }
    if (!EMAIL_RE.test(email)) {
      return "Укажите корректный email";
    }
    if (!values.city.trim()) {
      return "Укажите город";
    }
    return null;
  }

  if (!values.legal_name.trim()) {
    return "Укажите юридическое название";
  }
  if (!values.iin_bin.trim()) {
    return "Укажите БИН / ИИН";
  }
  if (!values.city.trim()) {
    return "Укажите город";
  }
  if (!values.address.trim()) {
    return "Укажите юридический адрес";
  }
  if (!values.contact_person.trim()) {
    return "Укажите контактное лицо";
  }
  if (!phone) {
    return "Укажите телефон";
  }
  if (!email) {
    return "Укажите email";
  }
  if (!EMAIL_RE.test(email)) {
    return "Укажите корректный email";
  }
  return null;
}
