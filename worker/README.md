# CV API (Cloudflare Worker) - comenzi pentru proprietar

Toate comenzile se ruleaza in folderul `worker/`. Necesita Node 18+.
Adresa API: variabila `CV_API` sau fisierul `worker/.cv-api-url` (ignorat de git).
Tokenul admin sta in `%USERPROFILE%\.cv-admin\token` (in afara proiectului; poate fi schimbat cu `CV_ADMIN_TOKEN_FILE`).

## Prima instalare (exact in ordinea asta)

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create cv` - copiaza `database_id` in `wrangler.toml`
4. `npx wrangler d1 migrations apply cv --remote`
5. **Intai deploy:** `npx wrangler deploy` - apoi pune adresa Worker-ului (ex. `https://cv-api.<cont>.workers.dev`) in `worker/.cv-api-url`
6. `node admin.mjs init-token` - genereaza tokenul admin, il trimite la Cloudflare si il salveaza local
7. `node admin.mjs init-data-key --force` - genereaza cheia de criptare direct in Cloudflare (nu se afiseaza, nu se salveaza).
   Inainte verifica pe server ca nu exista nicio versiune; daca exista, refuza. **Se ruleaza o singura data, niciodata din nou** (vezi „Recuperare”).
8. Secretele scrise de tine:
   - `npx wrangler secret put GEMINI_KEY` - o cheie **NOUA** din Google AI Studio, restrictionata in Google Cloud doar la
     „Generative Language API”. **Sterge cheia veche**: a stat in browsere si in linkuri, deci trebuie considerata furata.
   - `npx wrangler secret put CONTACT_TEXT` - ex. `Sună-l pe Andrei: 07xx xxx xxx`.
     Pe telefon apare asa: „{contact}. Spune-i că ai terminat.” (deci fara punct la final).
9. In site: pune adresa Worker-ului in `api.js` (`API_BASE`, in locul `https://cv-api.REPLACE_AT_DEPLOY.workers.dev`)
   si in `index.html`, in `Content-Security-Policy` la `connect-src` (aceeasi adresa).
10. `node admin.mjs set-pin` - PIN de minim 6 cifre, introdus de doua ori (nu se vede pe ecran)
11. **Inainte sa publici (push) site-ul nou:** pe fiecare telefon/tableta a tatalui deschide aplicatia VECHE si fa o copie:
    ⚙️ → „Salvează o copie”. Ia cea mai noua copie si importeaz-o (fisierul sta in afara proiectului!):
    `node admin.mjs import <copie.json>`. Dupa push, aplicatia veche nu mai exista, iar datele ei locale se sterg.
12. Publica site-ul (push).
13. `node admin.mjs pair "Telefon"` - da un link; trimite-l tatalui. Dupa ce te suna: `node admin.mjs devices`
    si `node admin.mjs approve <id>`. Repeta pentru tableta.

### Dupa deploy: verifica timpul de procesor la login

Ruleaza `npx wrangler tail` si intra o data in aplicatie cu PIN-ul. Uita-te la `cpuTime` pentru `/login`.
Planul gratuit Workers permite **10 ms CPU pe cerere**; verificarea PIN-ului (PBKDF2 cu 100 000 de iteratii) poate depasi.
Daca vezi erori de tip „exceeded CPU” sau timpi peste 10 ms, decizi tu: treci pe Workers Paid sau se reduce numarul de iteratii.

## Zi de zi

| Comanda | Ce face |
|---|---|
| `pair "<eticheta>"` | link nou de asociere (24 h, o singura folosire; anuleaza linkul vechi) |
| `devices` | lista dispozitivelor |
| `approve <id>` / `revoke <id>` / `unlock <id>` | aproba, revoca, deblocheaza un dispozitiv (maxim 3 active) |
| `unlock-all` | ridica blocarea globala |
| `audit [n]` | ultimele evenimente |
| `versions` | lista versiunilor CV |
| `export <id> <iesire.json>` | salveaza o versiune; refuza orice cale din folderul proiectului |
| `import <fisier.json>` | adauga o versiune noua ca ultima (verifica intai forma fisierului) |
| `set-pin` | schimba PIN-ul |

## Recuperare

- **Tata e blocat** („Aplicația e blocată”): `node admin.mjs devices` arata cine e blocat.
  Un singur dispozitiv: `node admin.mjs unlock <id>`. Blocare pe toate (prea multe PIN-uri gresite in 24 h): `node admin.mjs unlock-all`.
- **A uitat PIN-ul:** `node admin.mjs set-pin` si ii spui PIN-ul nou la telefon.
- **Telefon nou / pierdut:** `node admin.mjs pair "Telefon nou"`, el deschide linkul, apoi `approve <id>`;
  vechiul dispozitiv il scoti cu `node admin.mjs revoke <id-vechi>`.
- **Copii de siguranta:** din cand in cand `node admin.mjs versions` si `node admin.mjs export <id> <fisier.json>`
  intr-un folder **in afara proiectului** (proiectul este public).
- **Nu rula niciodata din nou `init-data-key`.** O cheie noua face toate versiunile salvate ilizibile pentru totdeauna.
  Comanda refuza fara `--force`, iar cu `--force` refuza daca pe server exista versiuni sau daca serverul nu raspunde.
  `--i-understand-data-loss` sare peste verificare: foloseste-l doar daca accepti sa pierzi tot.

Nu pune niciodata tokenul, PIN-ul sau CV-ul exportat in repo (este public).
