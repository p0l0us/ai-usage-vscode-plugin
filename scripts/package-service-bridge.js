// Bundle the same bridge sources for standalone npm installs of the service.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const target = path.join(root, 'service', 'bridge');
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(root, 'bridge', 'src'), path.join(target, 'src'), { recursive: true });
fs.copyFileSync(path.join(root, 'bridge', 'package.json'), path.join(target, 'package.json'));
