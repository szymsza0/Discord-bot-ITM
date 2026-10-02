/**
 * "Problem aware" script type for !skrypt: instead of leading with the
 * treatment/offer, the ad speaks to someone who already feels the problem
 * (complexes, hiding under make-up/filters) and only then reveals that there
 * is a way out. Differs from the standard ITM script in that it always
 * proposes 5 alternative hooks, each calling out the target group directly
 * (location + age range).
 *
 * PROBLEM_AWARE_REFERENCE_SCRIPT is the base pattern. It is also seeded into
 * the scripts sheet (see ensureProblemAwareSeed in commands/skrypt.js) as a
 * "(problem aware)" row, so it lives in the same database as every other
 * script and new problem-aware scripts pile up there as further examples.
 */

export const PROBLEM_AWARE_SEED_KLIENT = "Wzór ITM";
export const PROBLEM_AWARE_SEED_ZABIEG = "Usuwanie przebarwień / trądziku";
export const PROBLEM_AWARE_HOOK_COUNT = 5;

export const PROBLEM_AWARE_REFERENCE_SCRIPT = `Hook 1:
Kobieto z okolic Wrocławia w wieku 18 do 45 lat – Masz dosyć retuszowania zdjęć i chowania twarzy za filtrem, bo niedoskonałości nie dają Ci spokoju?

Hook 2:
Jesteś z okolic Wrocławia i boisz się wyjść bez makijażu, bo przebarwienia od razu rzucają się w oczy?

Hook 3:
Jesteś kobietą z Wrocławia, w wieku od 18-45 lat i marzy Ci się wyjść z domu bez grama makijażu i nie martwić się, co pomyślą inni?

Hook 4:
Jesteś kobietą z Wrocławia, w wieku od 18-45 lat i zakładasz makijaż codziennie, nawet wychodząc do żabki? Tak nie musi dłużej być.

Hook 5:
Kobieto z Wrocławia, chcesz znów czuć się piękna patrząc w lustro? Pokażę Ci jak pozbyć się swoich niedoskonałości, abyś znów emanowała pewnością siebie i dobrym samopoczuciem.

Kwestia 1:
Doskonale znam to uczucie, bo sama byłam w Twoim miejscu. Kompleksy to nie jest coś, o czym po prostu zapominasz. Trądzik, przebarwienia, chomiki – finalnie uczysz się z nimi żyć. A jeśli uda Ci się zaretuszować niedoskonałości, to i tak każde spojrzenie w lustro Ci o nich przypomina.

Kwestia 2:
Na szczęście jest na to sposób. Właściwie dobrana technologia może dzisiaj zdziałać cuda, o ile pasuje do Twojej skóry i trybu życia.

Dowodem tego są setki osób takich jak Ty, którym pomogłam. Nie dzięki certyfikatom, ale dzięki temu, że umiem dostrzec i wyłonić Twoje piękno. Po latach praktyki mogę to nazwać własną formułą, z którą dziś przychodzę do Ciebie.

Kwestia 3:
Bo sama wiem, jak to jest uwolnić się od kompleksu. I wiem, że Ty też na to zasługujesz. Każda kobieta powinna mieć prawo czuć się piękną, wolną i emanować pewnością siebie.

Promo + CTA:
Kliknij w reklamę i zgłoś się na konsultację, na której dowiesz się, jaki efekt możemy wypracować. Pierwszym 20 osobom w tym miesiącu podaruję zabieg niespodziankę w gratisie.
________________________________

Krótsza rolka - skrypt:

Jesteś kobietą z Wrocławia, w wieku między 18-45 lat i masz dosyć chowania przebarwień, trądzika, blizn czy innych niedoskonałości pod makijażem i filtrami? Istnieje na to sposób. Formuła, która pomogła setkom kobiet, dokładnie takim jak Ty, które zażegnały swoje kompleksy raz na zawsze. Jeśli chcesz znów poczuć się piękna, wolna i emanować pewnością siebie – kliknij w reklamę a dowiesz się więcej. Dla pierwszych 20 osób w tym miesiącu kosmetyki i zabieg niespodzianka w gratisie ;)`;

export const PROBLEM_AWARE_RULES = `TYP SKRYPTU: PROBLEM AWARE (nadrzedne wobec ogolnych zasad struktury powyzej, jesli sa sprzeczne).

Odbiorca juz czuje problem (kompleks, wstyd, ukrywanie sie pod makijazem/filtrami), ale jeszcze nie zna rozwiazania. Skrypt NIE zaczyna od nazwy zabiegu ani oferty - zaczyna od problemu i emocji odbiorcy, a zabieg/technologia pojawia sie dopiero jako "sposob", ktory istnieje.

Zasady:
1. Dokladnie ${PROBLEM_AWARE_HOOK_COUNT} alternatywnych hookow (do testow A/B), kazdy z innym katem (frustracja, strach przed ocena, marzenie o wolnosci, codzienny rytual, obietnica zmiany).
2. Hooki bezposrednio adresuja grupe docelowa: lokalizacje (miasto/okolice) i KONKRETNY przedzial wieku (np. "w wieku 18-45 lat"), w wiekszosci hookow. Wiek dobierz do grupy docelowej z briefu; jesli jej brak - do typowej grupy dla zabiegu.
3. Hooki to pytania lub zaczepki opisujace konkretna, codzienna sytuacje z problemem (filtr na zdjeciach, makijaz "nawet do zabki", spojrzenie w lustro) - bez nazwy zabiegu.
4. Body (Kwestie): 1) empatia - "znam to uczucie / bylam w Twoim miejscu", nazwanie problemow; 2) jest sposob - wlasciwie dobrana technologia/zabieg + dowod (liczba klientek, lata praktyki, wlasna formula); 3) zasluga i emocja docelowa - wolnosc, pewnosc siebie.
5. Promocja + CTA na koncu (konsultacja / formularz, limit np. "pierwszym 20 osobom w tym miesiacu" - tylko jesli wynika z briefu).
6. Krotsza rolka: jeden akapit - hook z wiekiem i lokalizacja, "istnieje na to sposob", dowod, emocja, CTA + promocja.
7. Mow jezykiem odbiorczyni, pierwsza osoba (ekspertka mowi do klientki), bez zargonu medycznego.`;
