# Spremembe: mesečno številčenje + paket za računovodstvo

## 1. Mesečno številčenje

- BP in BI imata ločeni zaporedji.
- Vsak nov mesec se obe zaporedji začneta pri `0001`.
- Uradni prikaz je `BP-YYYY-MM-0000` oziroma `BI-YYYY-MM-0000`.
- Primer: `BP-2026-09-0001`, `BI-2026-09-0001`.
- Sprememba je izvedena tako v lokalnem zaključku meseca kot v strežniškem `/api/close-month` zaključku.
- Že zaključeni dokumenti niso samodejno preštevilčeni; njihova shranjena zaporedna številka ostane nespremenjena zaradi sledljivosti.

## 2. Paket za računovodstvo

V pogledu **Poročila in izvoz** je dodan gumb **Paket za računovodstvo (.zip)**.

Paket upošteva trenutne filtre oziroma izbrane vrstice in vključuje samo uradno oštevilčene dokumente. ZIP vsebuje:

- Excel register `blagajna-OD-do-DO.xlsx`,
- `manifest-prilog.csv`, ki povezuje dokumente in priloge,
- `PREBERI-ME.txt`,
- mapo `priloge/`, razdeljeno po uradni številki in šifri blagajne, z originalnimi skeniranimi prilogami.

Stornirani, vendar uradno oštevilčeni dokumenti ostanejo vključeni in so jasno označeni kot stornirani.

## Preverjanje

- TypeScript preverjanje: uspešno.
- Strežniški JavaScript syntax check: uspešno.
- Vite production build: uspešno.
- Test zaključka meseca: avgust po že zaključenem juliju začne BP in BI ponovno pri 1; idempotentnost zaključka ostane ohranjena.
- ZIP writer: testni ZIP z Excelom in prilogo prestane `unzip -t` brez napak.
