# Getting your Huawei Health export

The privacy export is the only complete copy of your watch data. It holds:
- every workout, with its GPS track;
- per-minute steps;
- heart rate;
- sleep stages and sleep summaries;
- SpO2, stress and HRV.

## Request it

1. Open **Huawei Health** → **Me** → tap your **account name**.
2. **Privacy Centre** → **Request your data** → select **Health** (you can leave everything else unticked).
3. Choose a **password**. The ZIP is AES-encrypted with it, and you will type it into the dashboard.
4. Submit.

The email with the download link usually arrives within a day; Huawei allows up to 7 days. The link stays valid for **21 days**. You can also request the data on the web: sign in to your HUAWEI ID → Privacy Centre → Request your data.

## Import it

Open the artifact → **Data** → drop the ZIP (or choose it) → enter the password → **Import**.

- **Where it is read:** your browser decrypts and parses the file. The ZIP itself is never uploaded.
- **What happens to old data:** a new import merges with what is already there. Records with the same ID are replaced, and days already covered are refreshed.
- **If the ZIP will not open:** extract it with 7-Zip and choose the extracted folder instead. Windows Explorer cannot open AES ZIPs.

## When something looks wrong

Devices and firmware export slightly different files. After each import the Data tab shows a **format report**: file names, record types and counts, never your values. The report is saved privately so Claude can read it and adapt the parser. Ask Claude something like "check my last import's format report".

Known gaps:
- Some exports (mid-2024) had no GPS tracks.
- Some recent ones have no type-9 sleep stages; the dashboard then uses the nightly sleep summaries instead.
