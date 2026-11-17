# Audyt produktu i UX — 2026-11-17

Zakres: panel OpenAdmin (admin, reseller, user), wszystkie 374 trasy, 66 tras
administratora, 24 resellera i 39 użytkownika, formularze, kreatory, listy,
stany puste, akcje destrukcyjne, mobilność, język, dostępność i spójność.
Podstawa: przegląd kodu, 313 testów, QA 54/54 (395 kombinacji trasa/szerokość,
65 screenshotów 390/768/1024/1280/1440) oraz ręczny przegląd kluczowych ekranów.

## Werdykt

Fundament jest dobry: bezpieczeństwo, trwałość operacji, uczciwe statusy,
responsywność bazowa i dostępność stoją wyżej niż w typowym panelu hostingowym.
Największe problemy nie dotyczą funkcji, tylko **tarcia w codziennych zadaniach**:
mobilne listy nadal miejscami się ściskają, język jest niespójny, długie formularze
i kreatory wymagają zbyt wielu kroków, a część akcji jest ukryta za ikonami.

Ocena robocza: **3,2/5**.
- Bezpieczeństwo i zaufanie: 4,5/5
- Funkcje i kompletność: 4/5
- Łatwość codziennej obsługi: 2,5/5
- Spójność wizualna i językowa: 2,5/5
- Mobilność: 2,5/5
- Dostępność: 4/5

## Najważniejsze ustalenia

### P1 — natychmiast widoczne

1. **Mobilna lista skrzynek obcina limit i nagłówki.**
   `Email Accounts` na 390 px pokazuje nagłówek `LIM` i ucięte wartości
   `96`, `3.0`, `41`, `780`; akcje są pionowym stosem ikon. Tabela nie używa
   `responsive-table`, więc walory kart nie działają. To samo dotyczy listy
   domen resellera. Dowód: [email-mobile.png](ux-audit-2026-11-17/email-mobile.png).

2. **Karty Security Center nachodzą na siebie.**
   W `Centrum bezpieczeństwa` wartości i badge (`niedostępne`, `prohibit-password`,
   `hproc 200`, `nofile 4096`) wchodzą na etykiety w kartach Firewall/SSH/
   Fork bomb/ModSecurity. `kvList` ma dwie kolumny w wąskiej karcie 3-kolumnowego
   gridu. Dowód: [security-cards.png](ux-audit-2026-11-17/security-cards.png).

3. **Domeny resellera mają nieopisane ikony akcji.**
   Na telefonie widać tylko cztery ikony (DNS, aplikacja, klient, login) bez
   tekstu i bez menu; nie wiadomo, co robią. Dodatkowo „Szybkie akcje” dublują
   nawigację. Dowód: [reseller-domains-mobile.png](ux-audit-2026-11-17/reseller-domains-mobile.png).

4. **Polski panel ma angielskie elementy w najbardziej widocznych miejscach.**
   Topbar: `Search pages and commands…`, `Live`, `Notifications`, `Switch to dark
   mode`, `Dark`. Pomoc: prawie cała strona po angielsku. E-mail: `Email Accounts`,
   `Active`, `Created`, `Actions`, `Create mailbox`, `Delete`. Pakiety:
   `Create Package`, `RESOURCE LIMITS`, `FEATURES`. Security: `Delete`, `Revoke`.
   Dowód: [help-english.png](ux-audit-2026-11-17/help-english.png).

5. **Akcja „Uruchom teraz” w Automatyzacji łamie się na cztery linie.**
   Na 390 px przycisk ma szerokość tekstu i wygląda jak `Uruch / om / teraz`.
   Strona ma 4680 px wysokości, powtarza te same karty zadań i miesza polskie
   etykiety z `STATUS`, `INTERVAL`, `NEXT RUN`, `RUNS / FAILURES`.
   Dowód: [automation-mobile.png](ux-audit-2026-11-17/automation-mobile.png).

### P2 — wyraźne tarcie w codziennej pracy

6. **Kreator pakietu to jeden ogromny formularz.**
   `Create Package` ma 2852 px na telefonie, ~20 pól, angielskie sekcje i
   przełączniki funkcji bez podziału na kroki, presety ani sticky save.
   „0 = unlimited” jest jednym ogólnym komunikatem, a feature set i indywidualne
   toggles nie pokazują, co jest nadpisywane. Dowód:
   [package-mobile.png](ux-audit-2026-11-17/package-mobile.png).

7. **Kreator konta ma pięć kroków nawet dla prostego klienta.**
   Logowanie, e-mail, właściciel, pakiet, domena/DNS, WWW/PHP/SSL/poczta i
   preflight. Dla „utwórz zwykłe konto z domeną” to za dużo; brak trybu szybkiego
   i brak możliwości wrócenia do podsumowania bez przechodzenia kroków.

8. **Menedżer plików nie skaluje się do codziennej pracy.**
   Brak wyszukiwania, sortowania, zaznaczania wielu plików, bulk delete/download,
   podglądu i wskaźnika quota. Jest tylko per-wiersz „Więcej”; meta `Uprawnienia`
   (755) jest eksponowana użytkownikowi bez kontekstu. Nagłówek i tytuł karty
   dublują „Menedżer plików”.

9. **Command palette szuka tylko stron i poleceń.**
   Nie znajdzie użytkownika, domeny, skrzynki, zgłoszenia ani backupu. Przy 66
   trasach administratora to główne miejsce, w którym powinno się szukać encji,
   a nie tylko nawigacji. Placeholder jest dodatkowo angielski.

10. **Brak spójnego słownika i jednostek.**
    `Klient / użytkownik / konto`, `Dodaj / Utwórz / Nowy`, `Aktywna / aktywny /
    gotowe / w normie / OK`, `MB / GB` z różną liczbą miejsc po przecinku.
    Użytkownik uczy się kilku nazw tego samego obiektu.

11. **Długie strony bez warstw informacji.**
    Pulpit użytkownika 2782 px, statystyki 3821 px, zdrowie serwera 2339 px,
    automatyzacja 4680 px, pakiety 2852 px. Wszystko jest równie ważne; brak
    zakładek, zwijanych sekcji, filtrów i zakresów dat.

12. **Sandbox pokazuje fałszywe „krytyczne”.**
    Security Center w sandboxie ma 0% i czerwone „krytyczna”, mimo że kontrole
    są niedostępne, nie nieudane. Health pokazuje 20 wierszy „Uwaga” z tym samym
    komunikatem o sandboxie. To uczy ignorowania alertów i podważa zaufanie do
    prawdziwych problemów.

13. **Stan „niedostępne” miesza się z „błędem”.**
    W kartach bezpieczeństwa badge „niedostępne” jest w tym samym wierszu co
    wartość; brakuje rozróżnienia `n/d` (nie dotyczy / sandbox) od `FAIL`.
    Podobnie w health: „Sandbox nie odczytuje…” powinno być jednym bannerem,
    a nie treścią każdego wiersza.

14. **Brak ochrony przed utratą długiego formularza.**
    Formularze pakietu, ustawień, backupu i kreatorów nie ostrzegają przy
    opuszczeniu strony; błąd walidacji często wraca jako flash i gubi wpisane
    wartości (np. e-mail, baza).

15. **Potwierdzenia destrukcyjnych akcji są niespójne i po angielsku.**
    Wiele `data-confirm` ma angielskie treści (`Delete this database...`,
    `Remove this application?`), część akcji ma potwierdzenie tylko w kodzie klienta lub nie ma go wcale
    (np. usunięcie wiadomości webmaila, catch-all). „Wdróż wszystko ponownie”
    w health nie ma potwierdzenia, mimo że przepina vhosty, DNS i pocztę.

### P3 — polish i skalowanie

16. **Tabele nie są systematycznie responsywne.**
    Tylko ok. 12 deklaracji `responsive-table`/`responsive: true` na ponad 120
    powierzchni tabel/list. Część list działa dzięki poziomemu scrollowi, ale to
    nie jest mobilny wzorzec kart; użytkownik musi przesuwać tabelę w bok.

17. **Brak paginacji i filtrów server-side w większości list.**
    Listy ładują wszystkie wiersze i filtrują po stronie klienta. Przy 500
    domenach, tysiącach wiadomości lub logów to problem wydajności i użyteczności.

18. **Brak akcji masowych w miejscu pracy.**
    Operacje masowe istnieją, ale na osobnej stronie `/admin/bulk` i
    `/reseller/bulk`; nie ma zaznaczania wierszy w listach użytkowników, domen,
    skrzynek czy plików. Użytkownik musi przepisywać filtry i wybierać obiekty
    ponownie.

19. **Brak spójnego „co dalej” po utworzeniu obiektu.**
    Po dodaniu skrzynki wraca lista z flash; brak przycisków „Otwórz webmail”,
    „Pobierz ustawienia”, „Skopiuj hasło”. Po utworzeniu bazy brak panelu
    poświadczeń do skopiowania.

20. **Brak widoczności haseł i kopiowania poświadczeń.**
    Generatory istnieją w niektórych formularzach, ale nie ma jednego wzorca
    reveal/copy; użytkownik musi zaznaczać i kopiować ręcznie, a wygenerowane
    hasło łatwo zgubić.

21. **Pomoc jest przestarzała i niekontekstowa.**
    Pomoc opisuje „switch between Admin, Reseller and User views from the
    sidebar”, choć przełącznik jest w topbarze; jest po angielsku i nie linkuje
    do konkretnego formularza. Brak „?” przy polach i linków do dokumentacji.

22. **Brak spójnego feedbacku postępu dla długich operacji.**
    Część operacji ma joby i progress, ale użytkownik nie widzi globalnego
    wskaźnika „trwa w tle” poza pojedynczymi ekranami; brak toastu z linkiem do
    joba i ponowienia.

23. **Niespójne nazwy i ikony akcji.**
    `Edytuj / Edit`, `Zarządzaj / Manage`, `Setup / Ustawienia`, `Usuń / Delete`;
    ikony bez tekstu w tabelach; użytkownik musi hoverować, żeby zrozumieć akcję.

24. **Brak trybu „simple” na trudnych ekranach.**
    Ustawienia UI mają simple mode, ale zaawansowane ekrany (pakiety, backup,
    security, health) pokazują wszystkie techniczne pola bez trybu uproszczonego.

## Co bym zrobił — plan

### Etap 1: szybkie wygrane (1–2 dni)

- Naprawić mobilne karty e-mail: `responsive: true`, pełne etykiety quota/status,
  akcje w poziomym menu, brak przycinania liczb.
- Naprawić karty Security Center: `kvList(..., {cols: 1})` w `grid-3` lub
  `grid-template-columns: repeat(auto-fit,minmax(240px,1fr))`.
- Naprawić „Uruchom teraz”: `white-space: nowrap`, minimalna szerokość, pełna
  etykieta; na mobile akcje w jednym rzędzie lub menu.
- Zamienić ikony domen resellera na `Więcej` z tekstowymi pozycjami; usunąć
  duplikujące „Szybkie akcje” z dashboardu.
- Przepisać topbar i pomoc na polski; dodać test, który nie przepuści
  angielskich etykiet w domyślnym `pl`.
- Dodać `data-confirm` do health bulk i rekordów DNS; ujednolicić treści.

### Etap 2: uproszczenie workflow (3–5 dni)

- **Quick create konta**: jednookienkowy formularz (login, e-mail, pakiet,
  domena, opcjonalne WWW/poczta), z checkboxem „konfiguracja zaawansowana”.
  Wizard zostaje dla pełnego scenariusza; preflight na końcu.
- **Kreator pakietu**: presety (Starter/Business/Unlimited), sekcje
  `Zasoby`/`Funkcje`/`PHP` w `<details>` lub krokach, sticky summary i save,
  „nielimitowane” jako osobny toggle, jawny konflikt feature set vs checkbox.
- **Menedżer plików**: search, sort, breadcrumb, quota, zaznaczanie i bulk
  download/delete, podgląd pliku, usunięcie duplikatu tytułu.
- **Email**: widok „Wszystkie domeny”, search, bulk suspend/delete, menu akcji
  z tekstem.
- **Command palette**: wyniki z encji (użytkownicy, domeny, skrzynki, zgłoszenia)
  z sekcjami i „ostatnio odwiedzane”.

### Etap 3: system i skala (1–2 tygodnie)

- Wprowadzić słownik pojęć i jednostek: jeden zestaw nazw, statusów, dat,
  formatowania MB/GB i akcji; lint/test na brak mieszania języków.
- Ujednolicić `PageHeader`: tytuł, breadcrumb, jedna akcja główna, bez duplikatu
  tytułu w karcie; jeden komponent pustego stanu i błędów.
- Dodać paginację/server-side search do list użytkowników, domen, skrzynek,
  logów i backupów.
- Dodać bulk selection bezpośrednio w listach, z paskiem „zaznaczono N”.
- Dodać ochronę formularzy (dirty guard, zachowanie wartości po błędzie,
  inline errors, reveal/copy haseł).
- Dodać kontekstową pomoc (`?` przy polach, link do dokumentacji) i przepisać
  help na polski, z linkami do realnych ekranów.
- Dodać warstwy informacji: zakładki/filtry/zwijane sekcje na dashboardzie,
  statystykach, health i automatyzacji.
- Dodać testy UX: brak przyciętych wartości w kartach mobilnych, obecność
  etykiet akcji, brak angielskich stringów w `pl`, limity wysokości stron.

## Czego bym nie robił

- Nie przebudowywałbym panelu na SPA; obecny server-rendered model jest szybki,
  prosty i dobrze działa bez JS.
- Nie dokładałbym nowych funkcji, dopóki codzienne listy i formularze nie będą
  przewidywalne.
- Nie zmieniałbym modelu bezpieczeństwa ani separatora tenantów — ten obszar
  jest najmocniejszy.

## Kryteria akceptacji po etapie 1

- 390 px: brak uciętych wartości w kartach e-mail/domen; każda akcja ma tekst
  lub menu z tekstem.
- 1280 px: Security Center bez nakładających się etykiet i badge.
- Wszystkie widoczne stringi w domyślnym `pl` są polskie; test blokuje
  `Search pages and commands`, `Email Accounts`, `Create Package` itd.
- Automatyzacja: „Uruchom teraz” w jednej linii; strona ma filtry i zwijane
  szczegóły.
- QA 54/54 i 313 testów nadal przechodzą.
