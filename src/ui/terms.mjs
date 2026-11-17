// Shared Polish/English product vocabulary. New UI should take labels from
// here instead of introducing a third synonym for an existing object/action.
export const TERMS = {
  actions: {
    create: ['Create', 'Utwórz'],
    add: ['Add', 'Dodaj'],
    edit: ['Edit', 'Edytuj'],
    save: ['Save', 'Zapisz'],
    cancel: ['Cancel', 'Anuluj'],
    delete: ['Delete', 'Usuń'],
    search: ['Search', 'Szukaj'],
    more: ['More', 'Więcej'],
    retry: ['Retry', 'Ponów'],
    close: ['Close', 'Zamknij'],
  },
  objects: {
    user: ['User', 'Użytkownik'],
    customer: ['Customer', 'Klient'],
    domain: ['Domain', 'Domena'],
    mailbox: ['Mailbox', 'Skrzynka e-mail'],
    database: ['Database', 'Baza danych'],
    package: ['Package', 'Pakiet'],
    backup: ['Backup', 'Kopia zapasowa'],
    ticket: ['Ticket', 'Zgłoszenie'],
    file: ['File', 'Plik'],
    certificate: ['Certificate', 'Certyfikat'],
  },
  status: {
    active: ['Active', 'Aktywna'],
    suspended: ['Suspended', 'Zawieszona'],
    enabled: ['Enabled', 'Włączona'],
    disabled: ['Disabled', 'Wyłączona'],
    ok: ['OK', 'OK'],
    warning: ['Warning', 'Uwaga'],
    error: ['Error', 'Błąd'],
    unknown: ['Unknown', 'Nieznany'],
  },
  units: {
    unlimited: ['Unlimited', 'Bez limitu'],
    perMonth: ['per month', 'miesięcznie'],
  },
};

export function term(lang, group, key) {
  const pair = TERMS[group]?.[key];
  if (!pair) return key;
  return lang === 'en' ? pair[0] : pair[1];
}

export function statusLabel(lang, key) {
  return term(lang, 'status', key) || key;
}

export function moneyLabel(lang) {
  return lang === 'en' ? 'Billing' : 'Rozliczenia';
}
