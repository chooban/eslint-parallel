/**
* Node dependencies
**/
import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';

/**
* NPM dependencies
**/
import { CLIEngine } from 'eslint';
import { FileEnumerator } from 'eslint/lib/cli-engine/file-enumerator';
import { CascadingConfigArrayFactory } from '@eslint/eslintrc/lib/cascading-config-array-factory';

/**
* Local dependencies
**/
import { formatResults } from './formatter';

const cpuCount = Number(process.env.ESLINT_CPU_COUNT) ?? os.cpus().length;

function listFilesToProcess(patterns, options) {
  return Array.from(
    new FileEnumerator({
      ...options,
      configArrayFactory: new CascadingConfigArrayFactory({
        ...options,

        // Disable "No Configuration Found" error.
        useEslintrc: false
      })
    }).iterateFiles(patterns),
    ({ filePath, ignored }) => ({ filename: filePath, ignored })
  );
}

function hasEslintCache(options) {
  const cacheLocation = (
    options.cacheFile || options.cacheLocation || path.join(
      options.cwd || process.cwd(), '.eslintcache'
    )
  );
  try {
    fs.accessSync(path.resolve(cacheLocation), fs.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function eslintFork(options, files) {
  return new Promise((resolve, reject) => {
    const eslintChild = fork(path.resolve(__dirname, 'linter'));
    eslintChild.on('message', (report) => {
      if (report.errorCount || report.warningCount) {
        console.log(formatResults(report.results));
      }
      resolve(report);
    });
    eslintChild.on('exit', (code) => {
      if (code !== 0) {
        reject('Linting failed');
      }
    });
    eslintChild.send({options, files});
  });
}

export default class Linter {
  constructor (options) {
    this._options = options;
    this._engine = new CLIEngine(options);
  }

  run (files) {
    return new Promise((resolve) => {
      const report = this._engine.executeOnFiles(files);
      if (this._options.fix) {
        CLIEngine.outputFixes(report);
      }

      if (this._options.quiet) {
        report.results = CLIEngine.getErrorResults(report.results);
      }
      resolve(report);
    });
  }

  execute(patterns) {
    return new Promise((resolve, reject) => {
      const files = listFilesToProcess(
        patterns, this._options
      ).map(f => f.filename);

      const hasCache = hasEslintCache(this._options);

      if (!hasCache && files.length > 50 && cpuCount >= 2) {
        // too many items, need to spawn process (if machine has multi-core)
        const totalCount = {
          errorCount: 0,
          warningCount: 0
        };
        const chunkedPromises = [];
        const chunkSize = Math.ceil(files.length / cpuCount);
        for (let i = 0; i < files.length; i += chunkSize) {
          const chunkedPaths = files.slice(i, i + chunkSize);
          const chunckedPromise = eslintFork(
            this._options, chunkedPaths
          );
          chunckedPromise.then((report) => {
            totalCount.errorCount += report.errorCount;
            totalCount.warningCount += report.warningCount;
          });
          chunkedPromises.push(chunckedPromise);
        }
        Promise.all(chunkedPromises).then(() => {
          resolve(totalCount);
        });
      } else {
        this.run(files).then((report) => {
          if (report.errorCount || report.warningCount) {
            console.log(formatResults(report.results));
          }
          resolve(report);
        }, reject);
      }
    });
  }
}

process.on('message', ({options, files}) => {
  // make sure to ignore message to other nested processes
  if (files) {
    new Linter(options).run(files).then((report) => {
      process.send(report);
    }, (err) => {
      console.log(err);
      process.exit(1);
    });
  }
});
