#!/usr/bin/env node
/* globals cat, config, cp, ls, popd, pushd, pwd, rm, exec, exit, which */
/* eslint curly: 0 */
import 'colors';
import 'shelljs/global';
import path from 'path';
import semver from 'semver';
import yargs from 'yargs';

// do not die on errors
config.fatal = false;

//------------------------------------------------------------------------------
// constants
const repoRoot = pwd();
const packagePath = path.join(repoRoot, 'package.json');
const changelog = path.join(repoRoot, 'CHANGELOG.md');

const npmjson = JSON.parse(cat(packagePath));

//------------------------------------------------------------------------------
// check if one of 'rf-changelog' or 'mt-changelog' is used by project
const devDepsNode = npmjson.devDependencies;
const isCommitsChangelogUsed = devDepsNode &&
  devDepsNode['rf-changelog'] || devDepsNode['mt-changelog'];
if (isCommitsChangelogUsed && !which('changelog')) {
  printErrorAndExit('The "[rf|mt]-changelog" package is present in "devDependencies", but it is not installed.');
}

//------------------------------------------------------------------------------
// options
const configOptions = npmjson['release-script'] || {};
const bowerRoot = path.join(repoRoot, (configOptions.bowerRoot || 'amd/'));
const tmpBowerRepo = path.join(repoRoot, (configOptions.tmpBowerRepo || 'tmp-bower-repo'));

// let bowerRepo;
// if (npmjson.bowerRepo) {
//   bowerRepo = npmjson.bowerRepo;
// } else {
//   let match = npmjson.repository.url.match(/^git@github\.com:(.*)\.git$/);
//   match = match || npmjson.repository.url.match(/^git\+https:\/\/github\.com\/(.*)\.git$/);
//   let gitUrlBase = match && match[1];
//   gitUrlBase = gitUrlBase || npmjson.repository.url;
//   bowerRepo = `git@github.com:${gitUrlBase}-bower.git`;
// }
const bowerRepo = configOptions.bowerRepo; // if it is not set, then there is no bower repo

//------------------------------------------------------------------------------
// command line options
const yargsConf = yargs
  .usage('Usage: $0 <version> [--preid <identifier>]')
  .example('$0 minor --preid beta', 'Release with minor version bump with pre-release tag')
  .example('$0 major', 'Release with major version bump')
  .example('$0 major --dry-run', 'Release dry run with patch version bump')
  .example('$0 --preid beta', 'Release same version with pre-release bump')
  .command('patch', 'Release patch')
  .command('minor', 'Release minor')
  .command('major', 'Release major')
  .command('<version>', 'Release specific version')
  .option('preid', {
    demand: false,
    describe: 'pre-release identifier',
    type: 'string'
  })
  .option('dry-run', {
    alias: 'n',
    demand: false,
    default: false,
    describe: 'Execute command in dry run mode. Will not commit, tag, push, or publish anything. Userful for testing.'
  })
  .option('verbose', {
    demand: false,
    default: false,
    describe: 'Increased debug output'
  });

const argv = yargsConf.argv;

if (argv.dryRun) console.log('DRY RUN'.magenta);

config.silent = !argv.verbose;

const versionBumpOptions = {
  type: argv._[0],
  preid: argv.preid
};

if (versionBumpOptions.type === undefined && versionBumpOptions.preid === undefined) {
  console.log('Must provide either a version bump type, preid (or both)'.red);
  console.log(yargsConf.help());
  exit(1);
}


//------------------------------------------------------------------------------
// functions
function printErrorAndExit(error) {
  console.error(error.red);
  exit(1);
}

function run(command) {
  const { code, output } = exec(command);
  if (code !== 0) printErrorAndExit(output);
  return output;
}

function safeRun(command) {
  if (argv.dryRun) {
    console.log(`[${command}]`.grey, 'DRY RUN'.magenta);
  } else {
    return run(command);
  }
}

function release({ type, preid }) {
  if (type === undefined && !preid) printErrorAndExit('Must specify version type or preid');

  // ensure git repo has no pending changes
  if (exec('git diff-index --name-only HEAD --').output.length) {
    printErrorAndExit('Git repository must be clean');
  }
  console.info('No pending changes'.cyan);

  // ensure git repo last version is fetched
  if (/\[behind (.*)\]/.test(exec('git fetch').output)) {
    printErrorAndExit(`Your repo is behind by ${RegExp.$1} commits`);
  }
  console.info('Current with latest changes from remote'.cyan);

  // check linting and tests
  console.log('Running: '.cyan + 'linting and tests'.green);
  run('npm run test');
  console.log('Completed: '.cyan + 'linting and tests'.green);

  // version bump
  const oldVersion = npmjson.version;
  let newVersion;

  if (type === undefined) {
    newVersion = oldVersion; // --preid
  } else if (['major', 'minor', 'patch'].indexOf(type) >= 0) {
    newVersion = semver.inc(oldVersion, type);
  } else {
    newVersion = type; // '<version>', 'Release specific version'
  }

  if (preid) {
    newVersion = semver.inc(newVersion, 'pre', preid);
  }

  npmjson.version = newVersion;
  `${JSON.stringify(npmjson, null, 2)}\n`.to(packagePath);

  console.log('Version changed from '.cyan + oldVersion.green + ' to '.cyan + newVersion.green);
  safeRun('git add package.json');

  // npm run build
  console.log('Running: '.cyan + 'build'.green);
  const res = exec('npm run build');
  if (res.code !== 0) {
    // if error, then revert and exit
    console.log('Build failed, reverting version bump'.red);
    run('git reset HEAD .');
    run('git checkout package.json');
    console.log('Version bump reverted'.red);
    printErrorAndExit(res.output);
  }
  console.log('Completed: '.cyan + 'build'.green);

  const vVersion = `v${newVersion}`;

  // generate changelog
  if (isCommitsChangelogUsed) {
    run(`changelog --title ${vVersion} --out ${changelog}`);
    safeRun(`git add ${changelog}`);
    console.log('Generated Changelog'.cyan);
  }

  safeRun(`git commit -m "Release ${vVersion}"`);

  // tag and release
  console.log('Tagging: '.cyan + vVersion.green);
  safeRun(`changelog --title ${vVersion} -s | git tag -a -F - ${vVersion}`);
  safeRun('git push');
  safeRun('git push --tags');
  console.log('Tagged: '.cyan + vVersion.green);

  // npm
  console.log('Releasing: '.cyan + 'npm package'.green);
  safeRun('npm publish');
  console.log('Released: '.cyan + 'npm package'.green);

  // bower
  if (bowerRepo) {
    console.log('Releasing: '.cyan + 'bower package'.green);
    rm('-rf', tmpBowerRepo);
    run(`git clone ${bowerRepo} ${tmpBowerRepo}`);
    pushd(tmpBowerRepo);
    rm('-rf', ls(tmpBowerRepo).filter(file => file !== '.git')); // delete all but `.git` dir
    cp('-R', bowerRoot, tmpBowerRepo);
    safeRun('git add -A .');
    safeRun(`git commit -m "Release ${vVersion}"`);
    safeRun(`git tag -a --message=${vVersion} ${vVersion}`);
    safeRun('git push');
    safeRun('git push --tags');
    popd();
    if (argv.dryRun) {
      console.log(`[rm -rf ${tmpBowerRepo}]`.grey, 'DRY RUN'.magenta);
    } else {
      rm('-rf', tmpBowerRepo);
    }
    console.log('Released: '.cyan + 'bower package'.green);
  } else {
    console.log('The "bowerRepo" is not set in package.json. Not publishing bower.'.yellow);
  }

  console.log('Version '.cyan + `v${newVersion}`.green + ' released!'.cyan);
}


//------------------------------------------------------------------------------
//
release(versionBumpOptions);
