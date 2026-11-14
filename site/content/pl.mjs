// OpenAdmin landing page — Polish copy
export default {
  code: "pl",
  lang: "pl",
  ogLocale: "pl_PL",
  meta: {
    title: "OpenAdmin — darmowy panel hostingowy o otwartym kodzie",
    description:
      "Darmowy panel hostingowy zgodny z DirectAdminem. Cztery serwery WWW, poczta, DNS, backupy i API ze 110 komendami. AGPL-3.0, bez kluczy licencyjnych.",
    ogTitle: "Twój serwer. Twój panel. Twoje zasady.",
    ogDescription:
      "OpenAdmin to darmowy panel hostingowy o otwartym kodzie, który naprawdę należy do Ciebie. Zgodny z DirectAdminem, bez limitów i w pełni audytowalny.",
  },
  nav: {
    links: [
      { href: "#features", label: "Funkcje" },
      { href: "#screenshots", label: "Zrzuty ekranu" },
      { href: "#inside", label: "Wnętrze" },
      { href: "#install", label: "Instalacja" },
      { href: "#compare", label: "Porównanie" },
      { href: "#faq", label: "FAQ" },
    ],
    cta: "Pobierz OpenAdmina",
    primaryLabel: "Główna",
    mobileLabel: "Mobilna",
    menu: "Menu",
    close: "Zamknij menu",
    langAria: "Język",
  },
  hero: {
    eyebrow: "Darmowy i otwarty · AGPL-3.0 · v1.0",
    titleBefore: "Panel hostingowy, który naprawdę",
    titleAccent: "należy do Ciebie",
    titleAfter: ".",
    lead:
      "OpenAdmin to darmowy panel hostingowy zgodny z DirectAdminem, zbudowany do pracy na prawdziwych serwerach. Trzy poziomy dostępu, cztery serwery WWW, poczta, DNS, backupy i API ze 110 komendami — bez kluczy licencyjnych i bez zależności npm.",
    primary: "Zainstaluj w kilka minut",
    secondary: "Zobacz panel od środka",
    micro: ["Node.js ≥ 22.5", "Zero telemetrii", "Bez npm install"],
    stats: [
      { value: "4", label: "serwery WWW, jeden interfejs" },
      { value: "110", label: "komend CMD_API" },
      { value: "0", label: "opłat licencyjnych" },
      { value: "0", label: "zależności npm" },
    ],
    frame: {
      url: "openadmin.live:2222",
      alt: "Pulpit OpenAdmina z domenami, skrzynkami e-mail, transferem i limitami konta",
      caption: "Pulpit administratora — dane na żywo, prawdziwe pliki systemowe.",
    },
    chipLabels: ["zależności npm", "komend API", "bez opłat"],
  },
  tech: {
    label: "Działa z tym, co już masz na serwerze",
    items: [
      "Nginx", "Apache", "OpenLiteSpeed", "LiteSpeed", "MariaDB", "BIND",
      "Dovecot", "Exim", "WordPress", "phpMyAdmin", "Roundcube", "Nextcloud",
    ],
  },
  features: {
    eyebrow: "Co jest w środku",
    title: "Kompletny panel, nie demo.",
    lead:
      "Każdy ekran zapisuje prawdziwe pliki: strefy BIND, skrzynki Maildir, vhosty, crontaby i certyfikaty TLS. Panel jest produktem — nic nie zostało schowane za płatnym progiem.",
    cards: [
      {
        id: "levels",
        span: "lg",
        icon: "layers",
        kicker: "Model dostępu",
        title: "Trzy poziomy. Jedno logowanie.",
        body:
          "Admin ⊃ Reseller ⊃ Użytkownik, a limity pakietów są egzekwowane zarówno w interfejsie, jak i w API. Przełączasz poziom z panelu bocznego — bez drugiego konta i drugiego panelu.",
        visual: "levels",
      },
      {
        id: "deps",
        span: "md",
        icon: "package",
        kicker: "Łańcuch dostaw",
        title: "Zero zależności npm.",
        body:
          "Tylko wbudowane moduły Node.js: <code>node:http</code>, <code>node:sqlite</code>, <code>node:crypto</code>. Nie ma czego audytować poza naszym własnym kodem.",
        visual: "deps",
      },
      {
        id: "api",
        span: "md",
        icon: "terminal",
        kicker: "Zgodność",
        title: "DNA DirectAdmina.",
        body:
          "Wszystkie 110 opublikowanych komend <code>CMD_API_*</code> odpowiadają w znanym formacie <code>error=0&amp;list[]</code>. Twoje skrypty rozliczeniowe i provisioningowe już go znają.",
        visual: "api",
      },
      {
        id: "servers",
        span: "lg",
        icon: "server",
        kicker: "Stack WWW",
        title: "Cztery serwery WWW, jeden ekran.",
        body:
          "Nginx, Apache, OpenLiteSpeed i LiteSpeed Enterprise. Wykryj stack, wygeneruj vhost, zwaliduj, wdróż i przeładuj — bez ręcznego pisania konfiguracji.",
        visual: "servers",
      },
      {
        id: "mail",
        span: "sm",
        icon: "mail",
        kicker: "Poczta",
        title: "Poczta, która naprawdę wychodzi.",
        body:
          "Skrzynki, limity, przekierowania, autorespondery, catch-all, filtry spamu, webmail, IMAP i prawdziwa dostawa przez MX.",
        visual: "mail",
      },
      {
        id: "security",
        span: "sm",
        icon: "shield",
        kicker: "Bezpieczeństwo",
        title: "Bezpieczny domyślnie.",
        body:
          "Hasła scrypt, TOTP, tokeny CSRF, limitowanie logowań, menedżer plików w jailu i pełny dziennik audytu.",
        visual: "security",
      },
      {
        id: "files",
        span: "sm",
        icon: "folder",
        kicker: "Własność",
        title: "Wszystko należy do Ciebie.",
        body:
          "Strefy BIND, backupy tar.gz, certyfikaty OpenSSL, crontaby i unity systemd. Zwykłe pliki, nie zamknięta baza danych.",
        visual: "files",
      },
    ],
  },
  shots: {
    eyebrow: "Zobacz od środka",
    title: "Prawdziwe ekrany. Prawdziwa praca.",
    lead:
      "To prawdziwe zrzuty działającego panelu, nie makiety. Wybierz zakładkę i zobacz, jak wygląda Twój dzień.",
    note: "Zrzuty 1440 × 1150 z działającej aplikacji. Jasny i ciemny motyw w zestawie.",
    tabs: [
      {
        id: "dashboard",
        label: "Pulpit",
        kicker: "Poziom użytkownika",
        title: "Poranna odprawa",
        body:
          "Usługi, zużycie, domeny i zgłoszenia na jednym ekranie. Limity wynikają z pakietu konta, a nie z zahardkodowanego menu.",
        image: "dashboard",
        alt: "Pulpit użytkownika OpenAdmina z wykresem transferu, listą domen i limitami konta",
      },
      {
        id: "admin",
        label: "Admin",
        kicker: "Poziom administratora",
        title: "Cały serwer na jednym ekranie",
        body:
          "Użytkownicy, resellerzy, usługi, transfer i otwarte zgłoszenia. Restart, logi i podszycie się pod konto bez wychodzenia z panelu.",
        image: "admin",
        alt: "Pulpit administratora OpenAdmina z przeglądem serwera i statusem usług",
      },
      {
        id: "email",
        label: "E-mail",
        kicker: "Poczta",
        title: "Od skrzynki do webmaila",
        body:
          "Twórz skrzynki z limitami, ustaw przekierowania i autorespondery, a potem otwórz wbudowany webmail jednym kliknięciem.",
        image: "email",
        alt: "Ekran poczty w OpenAdminie ze skrzynkami i limitami",
      },
      {
        id: "webserver",
        label: "Serwer WWW",
        kicker: "Infrastruktura",
        title: "Cztery stacki, poprawnie generowane",
        body:
          "Wykryj, co jest zainstalowane, wygeneruj vhost dla domeny, sprawdź nawiasy i dyrektywy, wdróż i przeładuj usługę.",
        image: "webserver",
        alt: "Ekran serwera WWW w OpenAdminie z opcjami Nginx, Apache i LiteSpeed",
      },
      {
        id: "mariadb",
        label: "MariaDB",
        kicker: "Dane",
        title: "Prawdziwa baza, nie atrapa",
        body:
          "Połącz się z działającym MariaDB: przeglądaj bazy i konta, twórz i usuwaj, uruchamiaj SQL z konsoli.",
        image: "mariadb",
        alt: "Ekran MariaDB w OpenAdminie z bazami i konsolą SQL",
      },
      {
        id: "files",
        label: "Pliki",
        kicker: "System plików",
        title: "Menedżer plików w jailu",
        body:
          "Przeglądaj, wgrywaj, zmieniaj nazwy, edytuj inline i pobieraj archiwa — każda ścieżka jest kanonizowana i zamknięta w katalogu domowym konta.",
        image: "files",
        alt: "Menedżer plików OpenAdmina z katalogiem domowym konta",
      },
    ],
  },
  manifesto: {
    eyebrow: "Licencja to funkcja",
    quote: "Nic do kupienia. Nic do aktywowania. Nic za paywallem.",
    body:
      "OpenAdmin jest na licencji AGPL-3.0. Uruchom go na jednym serwerze albo na stu. Czytaj każdą linię, forkuj, poprawiaj, wdrażaj. Nie ma serwera licencji, limitu kont ani telefonowania do domu.",
    principles: [
      { title: "Darmowy na zawsze", body: "Bez zegara triala, bez rozliczania stanowisk, bez przycisku „Pro”." },
      { title: "Najpierw źródło", body: "Panel to czytelny JavaScript, od początku do końca." },
      { title: "Bez uzależnienia", body: "Strefy, poczta, backupy i baza zostają zwykłymi plikami." },
    ],
  },
  compare: {
    eyebrow: "Zgodność z DirectAdminem",
    title: "Ta sama pamięć mięśniowa. Inna licencja.",
    lead:
      "Jeśli Twój zespół zna DirectAdmina, zna już OpenAdmina: te same poziomy, te same nazwy paneli i ta sama konwencja API. Zmienia się to, co jest pod spodem.",
    columns: { open: "OpenAdmin", other: "Zamknięte panele" },
    rows: [
      { label: "Licencja", open: "AGPL-3.0, darmowa na zawsze", other: "Subskrypcja za serwer", tone: "good" },
      { label: "Konta i domeny", open: "Bez limitu", other: "Często w pakietach", tone: "good" },
      { label: "Kod źródłowy", open: "Czytelny JavaScript", other: "Zamknięty", tone: "good" },
      { label: "API", open: "110 CMD_API + REST + OpenAPI", other: "Zależne od dostawcy", tone: "good" },
      { label: "Dane panelu", open: "SQLite + zwykłe pliki", other: "Nieprzejrzysty magazyn", tone: "good" },
      { label: "Rozszerzenia", open: "Wtyczki, skórki, szablony", other: "Rozszerzenia dostawcy", tone: "good" },
      { label: "Migracja", open: "Import cPanel / DirectAdmin", other: "Narzędzia dostawcy", tone: "good" },
      { label: "Telemetria", open: "Brak", other: "Różnie", tone: "good" },
    ],
    note:
      "OpenAdmin to niezależna implementacja napisana od zera. Dzieli konwencję CMD_API, architekturę informacji i konwencje danych — nie kod, binaria ani assety. DirectAdmin jest znakiem towarowym swojego właściciela.",
  },
  inside: {
    eyebrow: "Wnętrze pudełka",
    title: "Nudna technologia. Celowo.",
    lead:
      "Jeden proces Node, jeden plik SQLite, zero kroku build. Wszystko uprzywilejowane przechodzi przez granicę providera, więc możesz testować na laptopie i przenieść się na Linuksa bez uczenia się produktu od nowa.",
    points: [
      {
        icon: "database",
        title: "node:sqlite",
        body:
          "WAL, transakcje i indeksy w jednym pliku, który możesz skopiować. Backup to plik, nie eksport od dostawcy.",
      },
      {
        icon: "shield",
        title: "sandbox → linux",
        body:
          "Jedna granica providera odpowiada za dostęp do systemu. Interfejs nigdy nie udaje, że usługa została zrestartowana, jeśli nie została.",
      },
      {
        icon: "route",
        title: "119 tras",
        body:
          "Pełna zgodność tras frontendu DirectAdmina z oryginalnymi tytułami stron oraz wszystkimi 110 historycznymi adresami CMD_*.",
      },
      {
        icon: "package",
        title: "npm install nie jest potrzebne",
        body:
          "Bez natywnych dodatków, bez dryfu lockfile’a, bez niespodzianek w łańcuchu dostaw. Klonujesz i uruchamiasz.",
      },
    ],
    specLabel: "Mapa systemu",
    tree: [
      "openadmin/",
      "├── src/server.mjs          HTTP · sesje · routing",
      "├── src/providers/          granica sandbox → linux",
      "├── src/features/           jeden moduł na obszar panelu",
      "├── src/compat/             110 komend CMD_API",
      "├── bin/openadmin.mjs       install · doctor · backup",
      "├── data/openadmin.db       jeden plik SQLite",
      "└── install.sh              systemd · użytkownicy · TLS",
    ],
    specs: [
      { k: "Środowisko", v: "Node.js ≥ 22.5" },
      { k: "Zależności", v: "0" },
      { k: "Baza danych", v: "node:sqlite (WAL)" },
      { k: "Port panelu", v: "2222" },
      { k: "Licencja", v: "AGPL-3.0-or-later" },
      { k: "Telemetria", v: "Brak" },
    ],
  },
  install: {
    eyebrow: "Zacznij",
    title: "Od zera do panelu w czasie jednej kawy.",
    lead:
      "Jedyny wymóg to Node.js 22.5+. Wypróbuj demo na laptopie albo uruchom instalator produkcyjny na świeżym Debianie, Ubuntu, Rocky lub AlmaLinux.",
    tabs: [
      {
        id: "demo",
        label: "Wypróbuj demo",
        title: "Przekop się przez panel na laptopie",
        body:
          "Pobiera źródła, uruchamia panel na porcie 2222 i zakłada trzy konta demo. Bez serwera bazy, bez roota, bez rejestracji.",
        code:
          "curl -fsSLO \\\n" +
          "  'https://openadmin.live/openadmin-1.0.0.tar.gz?v=1.0.0'\n" +
          "tar xzf openadmin-1.0.0.tar.gz \\\n" +
          "  && cd openadmin-1.0.0\n" +
          "OA_DEMO=1 node src/server.mjs",
        note: "Następnie otwórz http://127.0.0.1:2222.",
        accounts: [
          { level: "Użytkownik", user: "demouser", pass: "demo" },
          { level: "Reseller", user: "demoreseller", pass: "demo" },
          { level: "Admin", user: "demoadmin", pass: "demo" },
        ],
      },
      {
        id: "linux",
        label: "Instalacja na Linuksie",
        title: "Utwardzona instalacja jedną komendą",
        body:
          "Tworzy użytkownika systemowego i katalog danych, instaluje Node.js, jeśli trzeba, zapisuje unit systemd i jednorazowo wypisuje wygenerowane hasło administratora.",
        code:
          "curl -fsSLO \\\n" +
          "  'https://openadmin.live/openadmin-1.0.0.tar.gz?v=1.0.0'\n" +
          "tar xzf openadmin-1.0.0.tar.gz \\\n" +
          "  && cd openadmin-1.0.0\n" +
          "sudo ./install.sh --port 2222",
        note:
          "Testowane na Debianie 12, Ubuntu 22.04+, Rocky 9 i AlmaLinux 9. Otwórz port 2222 w zaporze.",
        accounts: [],
      },
      {
        id: "cli",
        label: "CLI",
        title: "Zautomatyzuj nudne",
        body:
          "Te same operacje, których używa panel, dostępne z terminala: instalacja, start, reset hasła, dodanie użytkownika, backup i diagnostyka środowiska.",
        code:
          "node bin/openadmin.mjs install --demo\n" +
          "node bin/openadmin.mjs doctor\n" +
          "node bin/openadmin.mjs start\n" +
          "node bin/openadmin.mjs passwd admin --random",
        note: "Pełną listę komend znajdziesz w node bin/openadmin.mjs --help.",
        accounts: [],
      },
    ],
    asideNote: "W trybie sandbox działa bez roota. Dopiero provider linuksowy wykonuje zapisy systemowe.",
    facts: [
      { label: "Środowisko", value: "Node.js ≥ 22.5" },
      { label: "Port", value: "2222" },
      { label: "Licencja", value: "AGPL-3.0" },
    ],
    download: {
      label: "Pobierz źródła",
      file: "openadmin-1.0.0.tar.gz",
      meta: "AGPL-3.0 · 1.0.0 · archiwum źródeł",
    },
    copy: "Kopiuj",
    copied: "Skopiowano",
    accountLevel: "Poziom",
    accountUser: "Użytkownik",
    accountPass: "Hasło",
  },
  pricing: {
    eyebrow: "Cennik",
    title: "0 €. Nie trial.",
    lead:
      "Jedna licencja: AGPL-3.0. Bez limitu kont, domen i serwerów. Wsparcie to kod źródłowy i ludzie, którzy go czytają.",
    badge: "Darmowy na zawsze",
    plan: "OpenAdmin",
    price: "0 €",
    per: "na zawsze",
    features: [
      "Bez limitu kont, domen i serwerów",
      "Panele admina, resellera i użytkownika",
      "Wszystkie 110 komend CMD_API",
      "Nginx, Apache, OpenLiteSpeed, LiteSpeed",
      "Poczta, DNS, SSL, backupy, cron, bazy",
      "TOTP i dziennik audytu",
      "Pełny kod źródłowy i aktualizacje",
      "Zero telemetrii, zero serwera licencji",
    ],
    cta: "Pobierz v1.0.0",
    note: "Bez karty. Bez rejestracji. Bez „skontaktuj się z działem sprzedaży”.",
  },
  faq: {
    eyebrow: "Pytania",
    title: "Uczciwe odpowiedzi.",
    lead: "Jeśli czegoś tu brakuje, resztą dokumentacji jest kod źródłowy.",
    items: [
      {
        q: "Czy OpenAdmin naprawdę jest darmowy?",
        a: "Tak. Cały panel jest na licencji AGPL-3.0-or-later. Nie ma kluczy licencyjnych, limitów stanowisk ani funkcji za paywallem. Możesz używać go komercyjnie, modyfikować i redystrybuować na tej samej licencji.",
      },
      {
        q: "Czy to fork DirectAdmina?",
        a: "Nie. To niezależna implementacja napisana od zera. Świadomie odwzorowuje powierzchnię komend CMD_API, nazwy paneli i konwencje <code>/home/&lt;user&gt;/domains/…</code>, ale nie zawiera kodu, binariów ani assetów DirectAdmina.",
      },
      {
        q: "Czy zainstaluję go na hostingu współdzielonym?",
        a: "Nie do prawdziwej administracji systemem. OpenAdmin potrzebuje VPS-a lub serwera dedykowanego oraz roota do zapisu w <code>/etc</code>, przeładowywania usług i tworzenia użytkowników systemowych. Domyślny provider sandbox działa jednak na laptopie bez roota, do testów.",
      },
      {
        q: "Czy naprawdę zarządza pocztą i DNS?",
        a: "Tak, w granicach możliwości hosta: strefy BIND, skrzynki Maildir, pliki passwd Dovecota, mapy Exima, klucze DKIM, wbudowany webmail i usługa IMAP4rev1. Wysyłka na zewnątrz nadal wymaga działającego MTA na serwerze.",
      },
      {
        q: "Co stanie się z moimi danymi, jeśli odejdę?",
        a: "Nic nie zostaje uwięzione. Stan panelu to jeden plik SQLite; strony, strefy, poczta, certyfikaty i backupy to zwykłe pliki w katalogach kont. Zabierasz je ze sobą.",
      },
      {
        q: "Czy panel telefonuje do domu?",
        a: "Zero telemetrii, zero sprawdzania licencji, zero beaconów aktualizacji. Panel działa w całości na Twoim serwerze. Sam decydujesz, kiedy aktualizować.",
      },
      {
        q: "Czy mogę współtworzyć lub zrobić fork?",
        a: "Na tym polega AGPL. Czytaj źródła, zgłaszaj problemy, wysyłaj poprawki albo poprowadź projekt własną drogą. Baza kodu jest wystarczająco mała, by zrozumieć ją w jedno popołudnie.",
      },
    ],
  },
  finalCta: {
    eyebrow: "Gotowy, gdy Ty jesteś",
    title: "Twój serwer. Twój panel. Twoje zasady.",
    lead:
      "Zainstaluj OpenAdmina na świeżym VPS-ie albo wypróbuj go na laptopie. Zajmie to minutę i nic nie kosztuje.",
    primary: "Pobierz OpenAdmina",
    secondary: "Przeczytaj szybki start",
    github: "Zobacz źródła na GitHubie",
    micro: "AGPL-3.0 · Node.js ≥ 22.5 · Bez rejestracji",
  },
  footer: {
    tagline:
      "Darmowy panel hostingowy o otwartym kodzie, zgodny z DirectAdminem. Zbudowany na Node.js, bez trackerów.",
    groups: [
      {
        title: "Produkt",
        links: [
          { label: "Funkcje", href: "#features" },
          { label: "Zrzuty ekranu", href: "#screenshots" },
          { label: "Instalacja", href: "#install" },
          { label: "Cennik", href: "#pricing" },
          { label: "Pobierz", href: "/openadmin-1.0.0.tar.gz?v=1.0.0" },
        ],
      },
      {
        title: "Wiedza",
        links: [
          { label: "Wnętrze OpenAdmina", href: "#inside" },
          { label: "Zgodność", href: "#compare" },
          { label: "FAQ", href: "#faq" },
          { label: "GitHub", href: "https://github.com/JVNECZKO/openadmin", external: true },
          { label: "Licencja", href: "https://www.gnu.org/licenses/agpl-3.0.html", external: true },
        ],
      },
      {
        title: "Technologie",
        links: [
          { label: "Node.js", href: "https://nodejs.org", external: true },
          { label: "SQLite", href: "https://sqlite.org", external: true },
          { label: "DirectAdmin", href: "https://www.directadmin.com", external: true },
        ],
      },
    ],
    legal:
      "OpenAdmin jest niezależnym projektem i nie jest powiązany z DirectAdminem ani cPanel. Nazwy produktów należą do ich właścicieli.",
    rights: "© 2026 OpenAdmin. Wolny jak wolność.",
    langLabel: "Język",
  },
  a11y: {
    skip: "Przejdź do treści",
    openMenu: "Otwórz menu",
    closeMenu: "Zamknij menu",
    github: "OpenAdmin na GitHubie",
  },
};
