# QR podpisovanje BP/BI — 30. 9. 2026

Dodano podpisovanje zaključenih in oštevilčenih blagajniških dokumentov prek začasne QR povezave.

## Potek

1. V zaključenem BP/BI kliknite **QR podpis**.
2. Izberite eno ali več podpisnih vlog. Pri BP je privzeto predlagan **Vplačal**, pri BI **Prejel** (če polje še ni podpisano).
3. Kliknite **Ustvari QR kodo (30 min)**.
4. Oseba na Samsung tablici skenira QR, pregleda dejanski obrazec BP/BI in tapne označeno podpisno mesto.
5. Podpiše se s S Penom, prstom ali miško in potrdi podpis.
6. Če je bilo izbranih več polj, ista povezava vodi skozi preostala polja. Po zadnjem podpisu se javna povezava takoj zaklene.

## Varnost

- naključni 192-bitni žeton v URL-ju;
- na strežniku se shrani samo SHA-256 zgoščena vrednost žetona;
- veljavnost 30 minut (strežniško omejena na 5–120 min);
- povezava je vezana samo na en dokument in vnaprej izbrana podpisna polja;
- po vseh podpisih ali ročnem preklicu ni več uporabna;
- javna stran ne zahteva prijave, vendar ne omogoča dostopa do drugih delov Blagajne;
- skenirane priloge se na javno stran ne pošiljajo — na obrazcu so vidna le njihova imena;
- podpis in dogodek ustvaritve/preklica se zabeležita v strežnik in revizijsko sled.

## Namestitev

Pri dostopu prek domene/reverse proxyja nastavite v `.env`:

```env
PUBLIC_BASE_URL=https://blagajna.example.si
```

Ta naslov mora biti dosegljiv tudi s tablice. `docker-compose.yml` je posodobljen, da nastavitev posreduje aplikacijskemu strežniku.

## Preverjeno

- TypeScript `tsc --noEmit`;
- produkcijski Vite build;
- sintaksa `server/index.js`;
- vgrajeni QR encoder je bil preverjen z neodvisnim QR decoderjem in vrne izvirni URL;
- obstoječi test mesečnega številčenja in idempotentnega zaključka meseca še vedno uspe.
