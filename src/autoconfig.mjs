// Thunderbird/Outlook autoconfiguration for panel mail domains.
import { get, setting } from './db.mjs';

export function mailServer(domain) {
  return setting(`mail_host:${domain}`, `mail.${domain}`);
}

export function clientSettings(address) {
  const [local, domain] = String(address || '').split('@');
  const server = domain ? mailServer(domain) : setting('server_name', 'localhost');
  return {
    address, domain, server,
    imap: { host: server, port: 993, security: 'SSL/TLS', user: address },
    smtp: { host: server, port: 587, security: 'STARTTLS', user: address },
    webmail: `http://${setting('server_name', 'localhost')}/webmail`,
  };
}

export function autoconfigXml(address) {
  const s = clientSettings(address);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${escapeXml(s.domain || 'localhost')}">
    <domain>${escapeXml(s.domain || '')}</domain>
    <displayName>OpenAdmin Mail</displayName>
    <displayShortName>OpenAdmin</displayShortName>
    <incomingServer type="imap">
      <hostname>${escapeXml(s.imap.host)}</hostname>
      <port>${s.imap.port}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${escapeXml(s.smtp.host)}</hostname>
      <port>${s.smtp.port}</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
}

export function autodiscoverXml(address) {
  const s = clientSettings(address);
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type><Server>${escapeXml(s.imap.host)}</Server><Port>${s.imap.port}</Port>
        <SSL>on</SSL><SPA>off</SPA>
        <LoginName>${escapeXml(address)}</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type><Server>${escapeXml(s.smtp.host)}</Server><Port>${s.smtp.port}</Port>
        <SSL>on</SSL><SPA>off</SPA><SMTPLast>off</SMTPLast>
        <LoginName>${escapeXml(address)}</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;
}

function escapeXml(v) {
  return String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}
