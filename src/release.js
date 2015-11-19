#!/usr/bin/env node
/* globals cat, config, cp, ls, popd, pushd, pwd, rm, test, exec, exit, which */
/* eslint curly: 0 */
import 'colors';
import 'shelljs/global';
import path from 'path';
import semver from 'semver';
import yargs from 'yargs';
import request from 'request';

// do not die on errors
config.fatal = false;

//------------------------------------------------------------------------------
// constants
const repoRoot = pwd();
const packagePath = path.join(repoRoot, 'package.json');

const npmjson = JSON.parse(cat(packagePath));
const isPrivate = npmjson.private;
const devDepsNode = npmjson.devDependencies;

//------------------------------------------------------------------------------
// check if one of 'rf-changelog' or 'mt-changelog' is used by project
let isCommitsChangelogUsed = devDepsNode &&
  (devDepsNode['rf-changelog'] || devDepsNode['mt-changelog']);
if (isCommitsChangelogUsed && !which('changelog')) {
  printErrorAndExit('The "[rf|mt]-changelog" package is present in "devDependencies", but it is not installed.');
}

const isWithinMtChangelog = npmjson.name === 'mt-changelog';
isCommitsChangelogUsed = isCommitsChangelogUsed || isWithinMtChangelog;

//------------------------------------------------------------------------------
// options
const configOptions = npmjson['release-script'] || {};
const bowerRoot = path.join(repoRoot, (configOptions.bowerRoot || 'amd/'));
const tmpBowerRepo = path.join(repoRoot, (configOptions.tmpBowerRepo || 'tmp-bower-repo'));
const bowerRepo = configOptions.bowerRepo; // if it is not set, then there is no bower repo

const docsRoot = path.join(repoRoot, (configOptions.docsRoot || 'docs-built/'));
const tmpDocsRepo = path.join(repoRoot, (configOptions.tmpDocsRepo || 'tmp-docs-repo'));
const docsRepo = configOptions.docsRepo; // if it is not set, then there is no docs/site repo
const docsBuild = npmjson.scripts && npmjson.scripts['docs-build'];

const githubToken = process.env.GITHUB_TOKEN;

const altPkgRootFolder = configOptions.altPkgRootFolder;

const skipBuildStep = configOptions.skipBuildStep;

const defaultDryRun = configOptions.defaultDryRun !== 'false';

//------------------------------------------------------------------------------
// command line options
const yargsConf = yargs
  .usage('Usage: $0 <version> --run [--preid <identifier>]\nor\nUsage: $0 --only-docs --run')
  .example('$0 minor --preid beta --run', 'Release with minor version bump with pre-release tag. (npm tag `beta`)')
  .example('$0 major --run', 'Release with major version bump')
  .example('$0 major --notes "This is new cool version" --run', 'Add a custom message to release')
  .example('$0 major', 'Without "--run" option it will dry run')
  .example('$0 --preid alpha --run', 'Release same version with pre-release bump. (npm tag `alpha`)')
  .example('$0 0.101.0 --preid rc --tag canary --run', 'Release `v0.101.0-rc.0` pre-release version with npm tag `canary`')
  .command('patch --run', 'Release patch')
  .command('minor --run', 'Release minor')
  .command('major --run', 'Release major')
  .command('<version> --run', 'Release specific version')
  .option('preid', {
    demand: false,
    describe: 'pre-release identifier',
    type: 'string'
  })
  .option('tag', {
    demand: false,
    describe: 'Npm tag name for the pre-release version.\nIf it is not provided, then `preid` value is used',
    type: 'string'
  })
  .option('only-docs', {
    alias: 'docs',
    demand: false,
    default: false,
    describe: 'Publish only documents'
  })
  .option('run', {
    demand: false,
    default: false,
    describe: 'Actually execute command.'
  })
  .option('dry-run', {
    alias: 'n',
    demand: false,
    default: false,
    describe: 'With "defaultDryRun" option set this toggles "dry run" mode.'
  })
  .option('verbose', {
    demand: false,
    default: false,
    describe: 'Increased debug output'
  })
  .option('notes', {
    demand: false,
    default: false,
    describe: 'A custom message for release.\nOverrides [rf|mt]changelog message'
  });

const argv = yargsConf.argv;

config.silent = !argv.verbose;

const versionBumpOptions = {
  type: argv._[0],
  preid: argv.onlyDocs ? 'docs' : argv.preid,
  npmTagName: argv.tag || argv.preid
};

if (versionBumpOptions.type === undefined && versionBumpOptions.preid === undefined) {
  console.log('Must provide either a version bump type, "preid" or "--only-docs"'.red);
  console.log(yargsConf.help());
  exit(1);
}

let notesForRelease = argv.notes;

let dryRunMode = argv.dryRun || defaultDryRun;
if (argv.run) {
  dryRunMode = false;
}
if (dryRunMode) {
  console.log('DRY RUN'.magenta);
  if (defaultDryRun) console.log('For actual running of your command please add "--run" option'.yellow);
}

if (argv.preid) console.log('"--preid" detected. Documents will not be published'.yellow);
if (argv.onlyDocs && !argv.preid) console.log('Publish only documents'.yellow);


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
  if (dryRunMode) {
    console.log(`[${command}]`.grey, 'DRY RUN'.magenta);
  } else {
    return run(command);
  }
}

function safeRm(...args) {
  if (dryRunMode) console.log(`[rm ${args.join(' ')}]`.grey, 'DRY RUN'.magenta);
  else rm(args);
}

/**
 * Npm's `package.json` 'repository.url' could be set to one of three forms:
 * git@github.com:<author>/<repo-name>.git
 * git+https://github.com/<author>/<repo-name>.git
 * or just <author>/<repo-name>
 * @returns [<author>, <repo-name>] array
 */
function getOwnerAndRepo(url) {
  let match = url.match(/^git@github\.com:(.*)\.git$/);
  match = match || url.match(/^git\+https:\/\/github\.com\/(.*)\.git$/);
  const gitUrlBase = match && match[1];
  return (gitUrlBase || url).split('/');
}

function runAndGitRevertOnError(cmd) {
  const res = exec(cmd);
  if (res.code !== 0) {
    // if error, then revert and exit
    console.log(`"${cmd}" command failed, reverting version bump`.red);
    run('git reset HEAD .');
    run('git checkout package.json');
    console.log('Version bump reverted'.red);
    printErrorAndExit(res.output);
  }
}

function releaseAdRepo(repo, srcFolder, tmpFolder, vVersion) {
  if (!repo || !srcFolder || !tmpFolder || !vVersion) {
    printErrorAndExit('Bug error. Create github issue: releaseAdRepo - One of parameters is not set.');
  }

  rm('-rf', tmpFolder);
  run(`git clone ${repo} ${tmpFolder}`);
  pushd(tmpFolder);
  rm('-rf', ls(tmpFolder).filter(file => file !== '.git')); // delete all but `.git` dir
  cp('-R', srcFolder, tmpFolder);
  safeRun('git add -A .');
  safeRun(`git commit -m "Release ${vVersion}"`);
  safeRun(`git tag -a --message=${vVersion} ${vVersion}`);
  safeRun('git push --follow-tags');
  popd();
  safeRm('-rf', tmpFolder);
}

function release({ type, preid, npmTagName }) {
  if (type === undefined && !preid) printErrorAndExit('Must specify version type or preid');

  // ensure git repo has no pending changes
  if (exec('git diff-index --name-only HEAD --').output.length) {
    printErrorAndExit('Git repository must be clean');
  }
  console.info('No pending changes'.cyan);

  // ensure git repo last version is fetched
  exec('git fetch');
  if (/behind (.*)\]/.test(exec('git status -sb').output)) {
    printErrorAndExit(`Your repo is behind by ${RegExp.$1} commits`);
  }
  console.info('Current with latest changes from remote'.cyan);

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

  // npm run test
  // this step is placed after version bumping
  // for the case when documents are been built in "npm run test" script
  console.log('Running: '.cyan + '"npm run test"'.green);
  config.silent = !skipBuildStep;
  runAndGitRevertOnError('npm run test');
  config.silent = !argv.verbose;
  console.log('Completed: '.cyan + '"npm run test"'.green);

  // npm run build
  if (argv.onlyDocs && docsBuild) {
    console.log('Running: '.cyan + 'docs-build'.green);
    runAndGitRevertOnError('npm run docs-build');
    console.log('Completed: '.cyan + 'docs-build'.green);
  } else {
    if (npmjson.scripts.build && !skipBuildStep) {
      console.log('Running: '.cyan + 'build'.green);
      runAndGitRevertOnError('npm run build');
      console.log('Completed: '.cyan + 'build'.green);
    } else {
      console.log('Skipping "npm run build" step.'.yellow);
    }
  }

  const vVersion = `v${newVersion}`;
  const versionAndNotes = notesForRelease = notesForRelease ? `${vVersion} ${notesForRelease}` : vVersion;

  // generate changelog
  // within mt-changelog at this stage `./bin/changelog` is already built and tested
  const changelogCmd = isWithinMtChangelog ? './bin/changelog' : 'changelog';

  const changelog = path.join(repoRoot, 'CHANGELOG.md');
  const changelogAlpha = path.join(repoRoot, 'CHANGELOG-alpha.md');
  let changelogOutput, changelogArgs;
  if (preid) {
    changelogOutput = changelogAlpha;
    changelogArgs = '';
  } else {
    changelogOutput = changelog;
    changelogArgs = '--exclude-pre-releases';
  }

  if (isCommitsChangelogUsed) {
    let changelogAlphaRemovedFlag = false;
    if (test('-e', changelogAlpha)) {
      rm('-rf', changelogAlpha);
      changelogAlphaRemovedFlag = true;
    }

    run(`${changelogCmd} --title="${versionAndNotes}" --out ${changelogOutput} ${changelogArgs}`);
    safeRun(`git add ${changelog}`);
    if (preid || changelogAlphaRemovedFlag) {
      safeRun(`git add -A ${changelogAlpha}`);
    }

    console.log('Generated Changelog'.cyan);
  }

  safeRun(`git commit -m "Release ${vVersion}"`);

  // tag and release
  console.log('Tagging: '.cyan + vVersion.green);
  if (isCommitsChangelogUsed) {
    notesForRelease = run(`${changelogCmd} --title="${versionAndNotes}" -s`);
    safeRun(`changelog --title="${versionAndNotes}" ${changelogArgs} -s | git tag -a -F - ${vVersion}`);
  } else {
    safeRun(`git tag -a --message="${versionAndNotes}" ${vVersion}`);
  }
  safeRun('git push --follow-tags');
  console.log('Tagged: '.cyan + vVersion.green);

  if (!argv.onlyDocs) {
    // publish to GitHub
    if (githubToken) {
      console.log(`GitHub token found ${githubToken}`.green);
      console.log('Publishing to GitHub: '.cyan + vVersion.green);

      if (dryRunMode) {
        console.log(`[publishing to GitHub]`.grey, 'DRY RUN'.magenta);
      } else {
        const [githubOwner, githubRepo] = getOwnerAndRepo(npmjson.repository.url || npmjson.repository);

        request({
          uri: `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases`,
          method: 'POST',
          json: true,
          body: {
            tag_name: vVersion, // eslint-disable-line camelcase
            name: `${githubRepo} ${vVersion}`,
            body: notesForRelease,
            draft: false,
            prerelease: !!preid
          },
          headers: {
            'Authorization': `token ${githubToken}`,
            'User-Agent': 'release-script (https://github.com/alexkval/release-script)'
          }
        }, function(err, res, body) {
          if (err) {
            console.log('API request to GitHub, error has occured:'.red);
            console.log(err);
            console.log('Skip GitHub releasing'.yellow);
          } else if (res.statusMessage === 'Unauthorized') {
            console.log(`GitHub token ${githubToken} is wrong`.red);
            console.log('Skip GitHub releasing'.yellow);
          } else {
            console.log(`Published at ${body.html_url}`.green);
          }
        });
      }
    }

    // npm
    if (isPrivate) {
      console.log('Package is private, skipping npm release'.yellow);
    } else {
      console.log('Releasing: '.cyan + 'npm package'.green);

      const npmPublishCmd = preid ? `npm publish --tag ${npmTagName}` : 'npm publish';

      // publishing just /altPkgRootFolder content
      if (altPkgRootFolder) {
        // prepare custom `package.json` without `scripts` and `devDependencies`
        // because it already has been saved, we safely can use the same object
        delete npmjson.files; // because otherwise it would be wrong
        delete npmjson.scripts;
        delete npmjson.devDependencies;
        delete npmjson['release-script']; // this also doesn't belong to output
        const regexp = new RegExp(altPkgRootFolder + '\\/?');
        npmjson.main = npmjson.main.replace(regexp, ''); // remove folder part from path
        `${JSON.stringify(npmjson, null, 2)}\n`.to(path.join(altPkgRootFolder, 'package.json'));

        pushd(altPkgRootFolder);
        safeRun(npmPublishCmd);
        popd();
      } else {
        safeRun(npmPublishCmd);
      }

      console.log('Released: '.cyan + 'npm package'.green);
    }

    // bower
    if (isPrivate) {
      console.log('Package is private, skipping bower release'.yellow);
    } else if (bowerRepo) {
      console.log('Releasing: '.cyan + 'bower package'.green);
      releaseAdRepo(bowerRepo, bowerRoot, tmpBowerRepo, vVersion);
      console.log('Released: '.cyan + 'bower package'.green);
    } else {
      console.log('The "bowerRepo" is not set in package.json. Not publishing bower.'.yellow);
    }
  }

  // documents site
  if (!isPrivate && !preid && docsRepo) {
    console.log('Releasing: '.cyan + 'documents site'.green);
    releaseAdRepo(docsRepo, docsRoot, tmpDocsRepo, vVersion);
    console.log('Documents site has been released'.green);
  }

  console.log('Version '.cyan + `v${newVersion}`.green + ' released!'.cyan);
}


//------------------------------------------------------------------------------
//
release(versionBumpOptions);
