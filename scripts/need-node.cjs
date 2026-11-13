// The demos and tests are TypeScript that Node runs as it is, which takes Node 24. An older Node installs with only a
// warning and then fails with a stack trace that does not say why, so the commands of the README ask here first.
// Plain old JavaScript on purpose: it has to run on the Node it is about to turn away.
var major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error('Ainek needs Node 24 or newer; this is ' + process.version + '. With nvm: nvm install 24 && nvm use (the repo has an .nvmrc).');
  process.exit(1);
}
