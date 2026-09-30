# Povezana podpisna tablica — 2026-09-30

## Kaj je novo

Blagajna zdaj podpira stalno povezano podpisno tablico. QR se uporabi samo enkrat za povezovanje naprave, ne več za vsak BP/BI.

### Prva povezava tablice

1. Na PC-ju odprite **Nastavitve → Podpisna tablica**.
2. Kliknite **Poveži novo tablico**.
3. Na Samsung tablici skenirajte prikazani QR. QR velja 10 minut in je enkraten.
4. Tablica se odpre na stalni strani `/tablet` in varni žeton shrani v brskalnik naprave.
5. Tablica ostane povezana, dokler je ne odstranite v Nastavitvah ali izbrišete podatkov brskalnika na tablici.

### Dnevna uporaba

1. Odprite BP/BI (lahko tudi osnutek).
2. Kliknite **Pošlji na tablico**.
3. Izberite povezano tablico in podpisna polja.
4. Dokument se v približno dveh sekundah pojavi kot vrstica v čakalni vrsti na tablici.
5. Podpisnik tapne vrstico, pregleda isti BP/BI, tapne zahtevano podpisno polje in se podpiše s pisalom/prstom.
6. Po zadnjem zahtevanem podpisu se vrstica samodejno odstrani iz čakalne vrste.
7. Podpis se shrani v isti dokument in se sinhronizira nazaj na PC.

## Varnost

- Povezovalni QR je enkraten in velja 10 minut.
- Po povezavi dobi tablica naključni 256-bitni žeton; na strežniku se uporablja samo njegov SHA-256 ključ.
- Tablica nima uporabniškega dostopa do Blagajne in vidi samo dokumente, ki so ji poslani v podpis.
- Posamezna zahteva je vezana na eno tablico, en dokument in izbrana podpisna polja.
- Zahtevo je mogoče preklicati s PC-ja.
- Povezano tablico je mogoče kadarkoli odstraniti v Nastavitvah.
- V revizijsko sled se zapiše povezava tablice, pošiljanje dokumenta, preklic in vsak zajet podpis.

## Strežniška shramba

Nove zbirke `tablet_pairings`, `tablet_devices` in `tablet_jobs` uporabljajo obstoječo generično `records` shrambo. Pri PostgreSQL zato ni potrebna ročna migracija sheme.

## Nastavitev javnega naslova

`PUBLIC_BASE_URL` mora kazati na HTTPS naslov Blagajne, ki ga Samsung tablica lahko odpre, npr.:

```env
PUBLIC_BASE_URL=https://blagajna.example.si
```
