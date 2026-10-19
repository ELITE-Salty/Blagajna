# Spremembe - 19. 10. 2026: BP/BI tisk + računovodski paket

## Natisni BP/BI

- Besedilo iz internega polja **Opombe** se ne prikazuje več na natisnjenem BP/BI.
- Tiskanje ustvari **en sam izvod** vsakega BP/BI (ne več blagajniškega + prejemnikovega).
- Pri tisku več BP/BI je vsak na **svoji A4 strani, ležeče (landscape)**.
- Statusni vodni žigi za osnutke in stornirane dokumente ostanejo.
- Interno polje `notes` ostane shranjeno in urejljivo, spremenjen je le izpis.

## Poročila in izvoz > Paket za računovodstvo (.zip)

- Excel `blagajna-OD-do-DO.xlsx` nima več stolpcev `Status` in `Opombe`.
- V vsaki mapi `priloge/<uradna-stevilka>__<blagajna>/` je tudi
  `<uradna-stevilka>-PRINT.pdf`, in sicer **1 PDF / 1 stran A4 ležeče** za vsak BP/BI.
- PDF je izrisan z uradno številko, zneskom, namenom, konti, podatki podjetja,
  blagajno in morebitnimi digitalnimi podpisi; brez Opomb.
- Originalne skenirane priloge ostanejo nedotaknjene.
- `manifest-prilog.csv` in Excelov stolpec `Datoteke prilog` navajata tako PDF
  kot skene. `Št. prilog` pomeni število vseh datotek, vključno s PDF.
- CSV manifest prav tako ne vsebuje statusa.
- Če izdelava katerega koli PDF ne uspe, se izvoz prekine s sporočilom o napaki;
  paket brez pripadajočega izpisa se ne prenese.
- Ločeni gumb `Izvoz v Excel (.xlsx)` ni bil spremenjen.

## Postavitev / namestitev

Podatkovna baza, API, sheme in obstoječe evidence se ne spreminjajo. Nove
zunanje npm knjižnice niso potrebne.

**Pomembno:** Priložena mapa `dist/` vsebuje stare datoteke iz izvirnega arhiva.
Ker v okolju za pripravo sprememb npm register ni bil dosegljiv, gradnja Vite
ni bila ponovno izvedena. Pred uporabo/objavo je treba iz izvorne kode zgraditi
nov `dist/`:

```sh
npm ci
npm run build
```

Pri namestitvi z Dockerfile gradnja frontenda že poteka samodejno (`npm ci`
in `npm run build`).

## Izvedeni preskusi

- Samostojni TypeScript check novih PDF generatorjev: OK.
- Vseh 34 TS/TSX datotek je bilo pregledanih za sintaktične napake: OK.
- Testna izpisa BP in BI v Chromium: PDF veljaven, po 1 A4 stran, znaki č/š/ž
  in digitalni podpisi izrisani pravilno.
- Večkratni tisk prek CSS: 3 dokumenti -> 3 tiskalne strani.
- Testni XLSX: 12 stolpcev, brez `Status` in `Opombe`, pravilne poti do PDF.
- Testni ZIP: `unzip -t` potrdi celovitost datotek XLSX in obeh PDF.
