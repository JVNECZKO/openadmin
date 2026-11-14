# Audyt Webuzo 4.9.1 → OpenAdmin

**Data:** 2026-11-14  
**Cel:** `https://servercontrol.notmadeinchina.pl:2005/` (produkcja, Ubuntu 24.04, Webuzo 4.9.1, licencja Mini)  
**Metoda:** REA (Chrome DevTools Protocol) + przegląd 209 stron panelu administracyjnego.  
**Zakres:** panel administratora (root). Enduser panel nie był logowany — brak danych dostępowych do konta końcowego.  
**Bezpieczeństwo:** tylko logowanie i nawigacja GET. Nie wysłano żadnego formularza poza logowaniem, nie kliknięto zapisu, restartu, usuwania ani instalacji. Konfiguracja produkcji pozostała nietknięta.

---

## 1. Wnioski w skrócie

Webuzo to dojrzały, bardzo „operacyjny” panel hostingowy. Ma **204 pozycje menu** i **394 narzędzia MCP** wystawione przez API. Największa przewaga Webuzo nad OpenAdmin nie leży w wyglądzie, tylko w głębi funkcji serwerowych:

1. **Poczta** — 20 ekranów: deliverability, troubleshooter, kolejka, greylisting, RBL, routing, split delivery, raporty dostarczeń, Dovecot, naprawa uprawnień.
2. **Bezpieczeństwo** — 16 ekranów: IP block, SSH, klucze roota, polityka haseł, blokada krajów, compiler access, wheel, fork bomb, ModSecurity (reguły/wykrycia/vendorzy), SMTP restrictions.
3. **Backup** — Backuply: joby, serwery SSH/S3/FTP/SFTP/Dropbox/Google Drive/OneDrive, restic/borg/rsync, restore i self-backup dla użytkowników.
4. **Plany i limity** —CPU/RAM/IO/inode, feature sets, granularne włączanie funkcji, reseller privilege plans.
5. **PHP/Apache** — MultiPHP, rozszerzenia, INI, FPM, moduły Apache, distro packages, MySQL config.
6. **Migracja** — 8 źródeł (Webuzo, cPanel, CWP, DirectAdmin, Vesta, Plesk, InterWorx, ISPConfig), transfer live, wielu użytkowników.
7. **QoL** — wyszukiwarka globalna (`/`), edytowalne ulubione, CSV, paginacja, masowe akcje, powiadomienia, testy połączeń, support access.
8. **API/MCP** — klucze z zakresem `act` + serwer MCP z 394 narzędziami i uprawnieniami per narzędzie.

Nasze mocne strony, których Webuzo nie ma lub ma słabiej: **darmowość bez limitów**, prosty tryb dla laika, polski interfejs, kreator pierwszego uruchomienia, strona zdrowia z naprawą, realny WordPress/Nextcloud, import archiwów cPanel/DA, mobile, brak telemetrii. Tego nie warto porzucać.

**Werdykt:** nie kopiować całego Webuzo. Brać z niego „głęboką operację” (poczta, bezpieczeństwo, backup, limity, PHP/DNS) i zostawić nasz laikowy interfejs jako domyślny, a funkcje zaawansowane schować w trybie advanced.

---

## 2. Mapa funkcji Webuzo

| Obszar | Stron | Co zawiera |
|---|---:|---|
| Users | 18 | lista, tworzenie, demo, zawieszeni, zawieszone skrzynki, shell access, skeleton, resource usage, template editor, quota, bandwidth, resource limits, convert addon, e-mail do wszystkich, rearrange, reset bandwidth, mass modify |
| Plans | 5 | plany, feature sets, disable features |
| Resellers | 10 | lista, privileges, privilege plans, shared IP, IP delegation, change ownership, accounts, usage |
| Domains | 9 | domeny, parked, aliasy, addony, subdomeny, redirecty, forwarding, zmiana IP |
| Networking | 9 | IP pool, IPv6, resolver, hostname, rebuild, migracja IP, usage, reserved |
| Settings | 13 | panel config, general, timezone, rebranding, email templates, update, root password, ACL, email, import/export, license, brute force, kategorie |
| DNS | 9 | zone, TTL, cleanup, templates, MX, hostname A, blacklist, cluster |
| Email | 20 | konta, queue, ustawienia Exima, filtry domen/krajów, greylisting, deliverability, troubleshooter, statystyki, disk usage, routing, RBL, split delivery, raporty, relayers, remote SMTP, Dovecot, repair perms |
| Storage | 2 | storage backendy, dodawanie |
| Security | 16 | IP block, SSH, root keys, password strength, country block, compiler, 2FA, wheel, traceroute, SSH password auth, fork bomb, ModSecurity ×4, SMTP restrictions |
| Apps | 21 | katalog aplikacji, instalacje, aktualizacje, usługi, enduser apps, directory index, default apps, distro packages, Apache/PHP/MySQL/FTP config |
| SSL/TLS | 3 | AutoSSL + logi, key type, certyfikat usług |
| Import | 8 | Webuzo, cPanel, CWP, DirectAdmin, Vesta, Plesk, InterWorx, ISPConfig |
| Server Utilities | 12 | terminal, CPU/RAM/dysk/bandwidth, reboot, cron, contact manager, notices, server info, news, system mail |
| Plugins | 1 | installed plugins |
| Database Services | 11 | MySQL settings/root, DB/users, remote hosts, phpMyAdmin, procesy, repair, dbmap, Redis |
| Restart Services | 15 | Apache, MariaDB, FTP, BIND, Exim, Dovecot, PHP 5.6–8.4 |
| Logs | 10 | user logs, raw Apache/FTP, error/domain error, ModSec, login, rotation, brute force, email |
| System Health | 5 | process manager, disk usage, running processes, daily log, background killer |
| Support | 3 | ticket, centrum dokumentacji, support access |
| Updates | 2 | Webuzo + system |
| Integracje | — | Softaculous, Backuply, ImunifyAV |

Pełna lista 213 pozycji: [WEBUZO-FEATURES.csv](WEBUZO-FEATURES.csv).

---

## 3. Luki względem OpenAdmin

Legenda: ✅ mamy realnie · 🟡 częściowo / tylko stub / brakuje ważnej części · ❌ brak.

### 3.1 Bezpieczeństwo — największa luka operacyjna

| Funkcja Webuzo | U nas | Co brakuje |
|---|---|---|
| IP Block (single/range) | 🟡 brute force + logi | osobny panel blokad, whitelista, CIDR, import/export |
| SSH enable/disable, port | ❌ | ustawienia sshd, port, reload z walidacją |
| Root SSH keys | ❌ | generowanie/import/autoryzacja kluczy roota |
| Password strength per typ konta | ❌ | polityka haseł dla user/email/FTP/MySQL/SSH |
| Country management | ❌ | geo-blokada panelu (z listą wyjątków) |
| Compiler access | ❌ | grupa compiler, blokada gcc/make dla użytkowników |
| 2FA | ✅ TOTP + recovery | brak e-mail OTP, wymuszania ról, pytań kontrolnych |
| Wheel/sudo | ❌ | zarządzanie grupą sudo |
| Traceroute toggle | ❌ | włącz/wyłącz traceroute |
| SSH password auth | ❌ | przełącznik + rekomendacja kluczy |
| Shell fork bomb protection | ❌ | limity procesów dla sesji shell |
| ModSecurity | 🟡 status + polityka | brak przeglądu reguł, wykryć, vendorów, logów, per-domain |
| SMTP restrictions | ❌ | blokada bypassu MTA przez użytkowników |

**Wniosek:** mamy 2FA i audyt, ale brakuje „centrum bezpieczeństwa” z twardymi przełącznikami systemowymi. To P0, bo dotyczy całego serwera, nie pojedynczej strony.

### 3.2 Poczta — największa luka funkcjonalna

| Funkcja Webuzo | U nas | Co brakuje |
|---|---|---|
| Konta, forwardery, autorespondery, catch-all, vacation, listy, spam | ✅ | — |
| DKIM/SPF/DMARC, autoconfig | ✅ health + DKIM + autoconfig | brak testu per adres i rekomendacji naprawczych |
| Kolejka | 🟡 compat mail queue | brak pełnego UI: rozmiar, wiek, przyczyny, retry/delete, bulk |
| Ustawienia Exima | 🟡 deploy/sync | brak edytora podstawowych ustawień |
| Filtry domen/krajów | ❌ | blokowanie nadawców i geolokalizacji |
| Greylisting | ❌ | włącz/wyłącz + czasy |
| Deliverability/troubleshooter | 🟡 health | brak „wpisz adres → diagnoza” i sugestii DNS |
| Statystyki e-mail | 🟡 email summary | brak wykresów, top odbiorców/nadawców, odrzuceń |
| Disk usage per skrzynka | 🟡 usage | brak czyszczenia/kompaktowania |
| Routing/split delivery | ❌ | wybór lokalny/zdalny, subordinate host |
| Custom RBL | ❌ | lista RBL, włącz/wyłącz |
| Remote SMTP | ❌ | SMTP relay (SendGrid/SMTP2GO/turboSMTP) |
| Dovecot config | ❌ | protokoły, limity, TLS, ciphers |
| Repair mailbox permissions | ❌ | naprawa właściciela/uprawnień |
| Delivery report / relayers / sent summary | 🟡 tracking | brak raportów z filtrami i eksportem |

**Wniosek:** to nie „dodatek”, tylko codzienna praca hostingu. Nawet wersja read-only (diagnostyka + kolejka + raport dostarczeń) da ogromny skok jakości.

### 3.3 Backup i restore

| Funkcja Webuzo | U nas | Co brakuje |
|---|---|---|
| Backup lokalny | ✅ | — |
| Harmonogram dzienny | ✅ | — |
| Retencja | ✅ | — |
| Backup zdalny S3/SFTP/FTP/Dropbox/GDrive/OneDrive | ❌ | adaptery, szyfrowanie poświadczeń, test połączenia |
| Joby backupów (zakres, wykluczenia, cron, retry) | 🟡 tylko globalny | brak jobów per scope i per user |
| Przywracanie backupu serwera | ❌ | brak UI restore (jest tylko download) |
| Incremental rsync/restic/borg | ❌ | brak |
| Self-backup użytkownika | 🟡 ręczny | brak harmonogramu i zdalnych lokalizacji |
| Test połączenia | ❌ | brak przycisku „Test” |
| Powiadomienia | ✅ e-mail | brak kanałów dodatkowych |

### 3.4 Plany, limity, resellerzy

| Funkcja | U nas | Co brakuje |
|---|---|---|
| Limity domen/e-maili/DB/transfer/dysk | ✅ | — |
| CPU/RAM/IO/inode | ❌ | limity cgroups/systemd, quota inode |
| Feature sets / disable features | ❌ | granularne toggles funkcji per plan i globalnie |
| Hard quota | 🟡 | brak twardego egzekwowania inode/CPU |
| Reseller privilege plans | 🟡 podstawowe pakiety | brak planów uprawnień, limitów łącznych |
| Shared IP / IP delegation | ❌ | brak |
| Change ownership / mass modify | 🟡 move user | brak bulk ownership i mass modify |
| Demo users / suspended email users | ❌ | brak |
| Shell access / skeleton | 🟡 terminal/SSH | brak per-user shell i szablonu katalogu |
| Quota modification / reset bandwidth | 🟡 | brak wygodnych akcji bulk |

### 3.5 DNS

| Funkcja | U nas | Co brakuje |
|---|---|---|
| Strefy i rekordy | ✅ | — |
| MX entry | 🟡 edytor rekordów | brak dedykowanego kreatora MX |
| TTL per strefa | 🟡 per rekord | brak domyślnego TTL strefy |
| Szablony DNS | ❌ | brak |
| Cleanup DNS | ❌ | brak |
| Blacklist domen | ❌ | brak |
| DNS cluster | ❌ | brak |
| Hostname A | 🟡 setup | brak dedykowanego wpisu |

### 3.6 PHP, Apache, aplikacje

| Funkcja | U nas | Co brakuje |
|---|---|---|
| Multiphp | 🟡 wersje per domena | brak instalacji/zarządzania wersjami |
| PHP extensions | 🟡 tylko diagnostyka | brak enable/disable |
| PHP INI editor | 🟡 per domena | brak globalnego i szablonów |
| PHP-FPM settings | 🟡 generowane pule | brak UI (children, idle, limits) |
| Apache settings/modules/status | 🟡 wybór serwera + custom config | brak modułów, MPM, statusu |
| Katalog aplikacji (Softaculous) | ❌ tylko WP + Nextcloud | brak setek aplikacji |
| Installed apps/updates | 🟡 WP manager | brak update-all i innych aplikacji |
| Distro packages | ❌ | brak |
| MySQL config/repair/dbmap | 🟡 DB manager + db-monitor | brak repair, process kill, dbmap |
| FTP server config | 🟡 konta FTP | brak konfiguracji serwera |
| Redis | 🟡 compat strona | brak realnego zarządzania |
| Web Disk, Solr, Ruby/Perl apps | ❌ | brak |

### 3.7 Import i migracje

| Funkcja | U nas | Co brakuje |
|---|---|---|
| cPanel/DA z archiwum | ✅ | — |
| cPanel live transfer (SSH/rsync/API) | ❌ | brak |
| Wielu użytkowników naraz | 🟡 pojedynczo | brak kolejki i batch |
| Logi importu | 🟡 raport | brak trwałego logu i retry |
| CWP/Vesta/Plesk/InterWorx/ISPConfig | ❌ | brak |
| Import IP | ❌ | brak |

### 3.8 Operacje serwera, logi, wsparcie

| Funkcja | U nas | Co brakuje |
|---|---|---|
| Process manager | 🟡 tylko lista | brak kill/trace i „kill all by user” |
| Daily process log / background killer | ❌ | brak |
| CPU/RAM/dysk/bandwidth | 🟡 system info/statystyki | brak dedykowanych, lekkich widoków |
| Reboot | ✅ | — |
| Cron | ✅ | — |
| Contact manager (Slack/Discord/Telegram/Pushbullet) | ❌ | tylko e-mail |
| Notices/news/system mail | ❌ | brak centrum zdarzeń |
| Support tickets | ✅ | — |
| Support access (czasowy dostęp) | ❌ | brak |
| Logi: raw Apache/FTP, ModSec, login, brute force, e-mail | 🟡 audit + domain logs | brak pobierania, filtrów, rotacji |
| Log rotation config | ❌ | brak |
| Update center (panel + OS) | ❌ | brak |
| Storage backendy | ❌ | brak |
| Networking: IPv6, resolver, reserved, migration | 🟡 podstawowy IP pool | brak większości |
| Panel config: porty, aliasy, ACL, rebranding, szablony e-mail | 🟡 setup/skins | brak |
| API keys + MCP | 🟡 CMD API | brak kluczy z zakresami i MCP |

### 3.9 UX / QoL

| Funkcja Webuzo | U nas | Rekomendacja |
|---|---|---|
| Wyszukiwarka globalna + skrót `/` | ❌ | dodać command palette |
| Edytowalne „Favorites” | 🟡 quick actions/checklist | dodać przypinanie |
| CSV export, wybór liczby wierszy, bulk | ❌ | dodać do list |
| Powiadomienia + unread badge | 🟡 messages | dodać centrum zdarzeń |
| Test connection (backup, mail, SSL, import) | 🟡 health | dodać przyciski per usługa |
| Setup warning | ✅ kreator | — |
|Języki (17) | 🟡 PL/EN | rozszerzyć systematycznie |
| Motywy/rebranding | 🟡 skórki/dark | dodać logo/nazwę/stopkę |
| Support access | ❌ | dodać czasowy token |
| Import/export ustawień | ❌ | dodać |
| Inline help | ✅ help center | dodać linki kontekstowe |
| Mobile | ✅ | — |

---

## 4. Roadmapa wdrożeń

### P0 — stabilność i bezpieczeństwo (najpierw)

1. **Security Center** — `L`
   - Nowy `/admin/security` z sekcjami: IP block, SSH, klucze roota, polityka haseł, country block, compiler/wheel, fork bomb, SMTP restrictions, ModSecurity.
   - Realne provider methods + walidacja `sshd -t`, `nginx -t`, `apachectl configtest`; każda zmiana w audit logu, krytyczne akcje z re-auth/2FA.
   - Nie wystawiać terminala enduserom bez `shell` capability.

2. **Mail Operations Center** — `L`
   - `/admin/mail`: deliverability per domena, troubleshooter „adres → diagnoza”, kolejka, raport dostarczeń, greylisting, RBL, routing, remote SMTP.
   - Parser logów Exima do tabeli `mail_events` z retencją; filtry po domenie/statusie; brak wycieku pełnych adresów w UI dla resellera.
   - Etap 1 read-only (diagnostyka + kolejka + raporty), etap 2 przełączniki.

3. **Backup destinations + restore** — `L`
   - Rozszerzyć `src/backups.mjs`: adaptery S3/SFTP/FTP, szyfrowanie poświadczeń, test połączenia.
   - Joby: zakres (pliki/DB/poczta/cron/SSL), wykluczenia, harmonogram, retencja, retry.
   - Restore z potwierdzeniem, dry-run i kopią pre-restore; kolejka zadań w tle.

4. **PHP/Web stack manager** — `M`
   - `/admin/php`: wersje, rozszerzenia, INI, FPM (children/idle/limits), per-domain.
   - `/admin/apache`: moduły, MPM, handler, status; walidacja przed reloadem.

5. **Plany i limity** — `L`
   - Feature sets + globalne „disable features”.
   - CPU/RAM/IO/inode przez systemd slices/cgroups v2 + quota; fallback jawny „unsupported”, nie udawać.
   - Reseller privilege plans i limity łączne.

6. **DNS Operations** — `M`
   - TTL strefy, szablony, cleanup, blacklist, MX entry, hostname A, DNS cluster (etap później).

7. **Import live transfer** — `L`
   - cPanel/DA direct SSH/rsync + batch + logi + retry; kolejne panele w P2.

8. **Update center** — `M`
   - Sprawdzanie wersji panelu i pakietów OS, changelog, okno serwisowe, backup przed update, rollback.

### P1 — wydajność pracy i przewaga

9. **API keys + MCP** — `M/L`
   - Klucze z IP allowlist i scopes; MCP endpoint z rejestrem narzędzi (zacząć od 20–30 read-only), potem write z potwierdzeniem.
   - To nasz potencjalny wyróżnik: AI/automatyzacja bez klikania.

10. **Notification center + kanały** — `S/M`
    - E-mail, Slack, Discord, Telegram, webhook; centrum zdarzeń, unread badge, notices.

11. **Reseller tools** — `M`
    - Privilege plans, shared IP/delegation, change ownership, mass modify, resource usage.

12. **Support access + docs** — `S`
    - Czasowy token dostępu dla supportu, log użycia, automatyczne wygaśnięcie.

13. **AutoSSL management** — `S/M`
    - Logi, key type, certyfikat usług, ponów/cofnij.

14. **Log center** — `M`
    - Pobieranie raw Apache/FTP/ModSec/login/brute force, rotacja, filtry.

15. **Process manager actions** — `S`
    - Kill/trace, kill all by user, dzienny log, background killer z potwierdzeniem.

16. **Storage destinations** — `M`
    - Wiele ścieżek/dysków, alerty zapełnienia, przenoszenie kont.

17. **Panel config / rebranding / ACL** — `M`
    - Logo, nazwa, stopka, porty/aliasy, ACL, import/export ustawień, szablony e-mail.

18. **Domain variants** — `M`
    - Parked/alias/addon, forwarding, change IP.

19. **Quick UX wins** — `S`
    - CSV, paginacja, bulk, sortowanie, favorites, wyszukiwarka `/`, copy DNS, last/next backup.

### P2 — pełna paritas i integracje

- Katalog aplikacji (open-source: Joomla, Drupal, PrestaShop, Moodle, Ghost) zamiast Softaculous (licencja).
- Country e-mail filter, demo users, shell/skeleton, template editor, webdisk.
- Enduser apps/services, Ruby/Perl/Node runtime, PostgreSQL, Solr.
- Multi-server, DNS cluster, remote storage.
- Integracje ImunifyAV/ClamAV, Backuply-like, monitoring.
- Pełne tłumaczenia (17 języków) i audyt dostępności.

---

## 5. Szybkie wygrane (1 sesja każda)

1. **Command palette** (`/`): szukaj użytkowników, domen, skrzynek, zgłoszeń; akcje read-only.
2. **Przypinane favourites** na pulpicie (obok checklisty).
3. **CSV export + page size + bulk** dla list.
4. **Centrum powiadomień** z unread badge i filtrem.
5. **Test connection** przy backupie, poczcie, SSL, importcie.
6. **Strona usług** z kolorami i restartem (mamy health, brak restartu z tego widoku).
7. **Last/next backup** widget na pulpicie.
8. **Kopiuj rekordy** SPF/DKIM/DMARC/autoconfig.
9. **Linki „Pomoc”** przy każdym zaawansowanym formularzu.
10. **AutoSSL log** i przycisk „odnów”.
11. **Eksport/import ustawień panelu**.
12. **Rebranding** (logo/nazwa/stopka).

---

## 6. Czego nie kopiować

- **204 pozycje w menu** — u nas domyślnie simple mode; zaawansowane w advanced, inaczej laik się zgubi.
- **Limit licencji blokujący dodanie użytkownika** — Webuzo Mini pokazało „upgrade license with more users” przy tworzeniu konta. Nasza darmowość bez limitu to przewaga.
- **Root terminal bez dodatkowej bramki** — u nas terminal tylko dla uprawnionych, z audytem.
- **„Kill all processes by user”** — niebezpieczne; tylko z potwierdzeniem i 2FA.
- **Blokada krajów domyślnie** — false positives; tylko opt-in.
- **Gęste przyciski destrukcyjne** — u nas potwierdzenia i opisy skutków.
- **Wiązanie z jednym proprietary pluginem** (Softaculous/Backuply) — lepiej adaptery i otwarte formaty.

---

## 7. Ryzyka i uwagi

- Webuzo na produkcji ma **„initial setup is not completed”** — nie klikałem naprawy; to potencjalne ryzyko dla właściciela.
- DKIM/DMARC/SPF dla hostname nie są skonfigurowane; panel sam to pokazuje.
- 43 nieprzeczytane wiadomości i 60 notices — dużo szumu; u nas centrum zdarzeń powinno być filtrowalne.
- Nie testowano enduser panelu (brak credentials); rekomendacja: osobny audyt na koncie demo.
- Nie testowano operacji zapisu/restartu/importu (zakaz zmian na produkcji); ocena funkcji na podstawie UI i dostępnych ekranów.

---

## 8. Rekomendowana kolejność

**Fala 1 (najbliższa):** quick wins UX + Security Center (read-only) + Mail diagnostics + Backup remote/test/restore.  
**Fala 2:** PHP manager, plany/limity, DNS ops, notification center, API/MCP (read-only).  
**Fala 3:** import live, reseller privilege plans, storage, rebranding/ACL, pełne i18n.

Największy zwrot dla laika: **czytelne diagnozy poczty i backupów** (mniej zgłoszeń), a dla administratora: **bezpieczeństwo i limity** (mniej incydentów).

---

### Załączniki

- [WEBUZO-FEATURES.csv](WEBUZO-FEATURES.csv) — 213 pozycji menu z sekcjami i targetami.
- Dowody REA: `inspect_web_page` + `capture_web_screenshot` dla panelu Webuzo (sesja CDP), 209 stron nawigowanych GET.
