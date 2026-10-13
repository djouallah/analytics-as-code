// Power BI's model.bim, written from the model (semantic_model/ossie.yaml) with dax-sql's
// reader (dax-sql/formats/ossie.js): the TMSL the Ossie model stands for, every property of
// it (what Ossie has no place for is in its POWER_BI extensions). deploy_model.py runs it
// into its copy of semantic_model/, the Fabric item; the repo holds no model.bim.
//   node scripts/ossie_to_bim.mjs <out.bim>
// (yaml: `npm ci --prefix scripts`)
import { writeFile } from 'node:fs/promises';
import { ossieToTmsl } from '../dax-sql/formats/ossie.js';
import { readOssie } from './stage_pages.mjs';

const [out] = process.argv.slice(2);
if (!out) { console.error('usage: node scripts/ossie_to_bim.mjs <out.bim>'); process.exit(2); }
await writeFile(out, `${JSON.stringify(ossieToTmsl(await readOssie()), null, 2)}\n`);
