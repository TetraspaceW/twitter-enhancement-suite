// Builds dist/firefox and dist/brave (load these unpacked) plus a zip of each. No dependencies.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const base = JSON.parse(readFileSync('manifest.base.json', 'utf8'));
const targets = {
  firefox: {
    ...base,
    background: { scripts: ['lib.js', 'bg.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'twitter-enhancement-suite@tetraspace',
        strict_min_version: '140.0', // data_collection_permissions (world: MAIN needs 128)
        // Nothing leaves the browser unless you turn on gist sync, which sends who you blocked (an action on the
        // site) and their names and the tweet you blocked them over (site content). Asked for then: TES.askToSend.
        data_collection_permissions: { required: ['none'], optional: ['websiteActivity', 'websiteContent'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    },
  },
  brave: {
    ...base,
    background: { service_worker: 'bg.js' },
    minimum_chrome_version: '111', // content_scripts world: MAIN
  },
};

rmSync('dist', { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const dir = `dist/${name}`;
  cpSync('src', dir, { recursive: true });
  writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  execFileSync('zip', ['-qrX9', `../twitter-enhancement-suite-${name}.zip`, '.'], { cwd: dir });
  console.log(`built ${dir} and dist/twitter-enhancement-suite-${name}.zip`);
}
