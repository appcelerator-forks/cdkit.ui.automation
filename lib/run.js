/* eslint-disable import/no-dynamic-require */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

const logger = require('./logger');

const TEST_DIR = 'ui-tests';

let playerPid = -1;
let appiumProc = null;

/**
	an internal method to create an absolute path to a file in the TEST_DIR

	@param {String} file - a file relative to TEST_DIR
	@return {String} - an absolute path to a file in the TEST_DIR
*/
function getAbsolutePath(app, file) {
  return path.join(__dirname, '..', TEST_DIR, app, file);
}

/**
	an internal method to convert ChildProcess.spawn() arguments to be more cross-platform

	@param {String} cmd - the external program/process to call
	@param {Array} flags - the flags that will be passed to the external program/process
	@return {String} - returns the same program or cmd.exe
*/
function spawnConvert(cmd, flags) {
  if (os.platform() === 'win32') {
    flags.unshift('/c', cmd);
    return 'cmd.exe';
  }

  // macOS
  return cmd;
}

class Helper {
  /**
		given the suite argument (--suites), validate them and convert the
		comma-delimited string into a useful data structure.

		if --suites flag is not used, then create the comma-delimited string from
		all the test suites.

		@param {String} suiteArg - a comma delimited string of valid test suites
		@param {String} platformArg - name of the specific platform for the test suites (android, ios, windows)
		@return {Array} - array of json objects; the object properies are defined as:
			{
				abs: absolute path to the test suite in the TEST_DIR,
				name: the name of the test suite,
				platform: the target platform that the test suite is tested against
			}
	*/
  static transform(appArg, suiteArg, platformArg) {
    // eslint-disable-next-line global-require
    const configTests = require(`../ui-tests/${appArg}/config`);

    const suites = [];
    let suiteFiles = suiteArg || '';

    Object.keys(configTests).forEach((platform) => {
      Object.keys(configTests[platform]).forEach((suite) => {
        // ignore 'desiredCapabilities'; it's not a suite
        if (suite !== 'desiredCapabilities') {
          // if platformArg is specified, add only the suites for this platform
          if (!platformArg || platformArg === platform) {
            suiteFiles += `${suite}${path.sep}${platform}.js,`;
          }
        }
      });
    });

    // remove the last comma
    suiteFiles = suiteFiles.slice(0, suiteFiles.length - 1);

    const files = suiteFiles.split(',');
    files.forEach((file) => {
      // checks if the suites exist in the TEST_DIR directory.
      try {
        fs.statSync(path.join(TEST_DIR, appArg, file));
      } catch (err) {
        logger.error(`'${file}' doesn't exist in '${TEST_DIR}' directory.`);
        process.exit(1);
      }

      const parts = file.split(path.sep); // separate path by system's file separator
      const suite = parts[0];
      const platformFile = parts[1];

      const extensionIndex = platformFile.length - '.js'.length;
      const platform = platformFile.slice(0, extensionIndex);

      // simple check if platform is supported
      const notSupported =
        platform !== 'ios' && platform !== 'android' && platform !== 'windows';
      if (notSupported) {
        logger.error(`${file}: '${platform}' is not a valid platform.`);
        process.exit(1);
      }

      suites.push({
        abs: getAbsolutePath(appArg, file),
        name: suite,
        platform,
      });
    });

    return suites;
  }

  /**
		starts and run the local appium server.

		@param {Object} server - the server property from test_config.js
		@param {Function} done - the callback to call when the server is up and running
	*/
  static runAppium(server, done) {
    let appiumExe = path.join(
      __dirname,
      '..',
      'node_modules',
      '.bin',
      'appium',
    );
    if (os.platform() === 'win32') {
      // use the windows compatible appium script
      appiumExe += '.cmd';
    }

    // Appium server additional flags
    const flags = [];

    const cmd = spawnConvert(appiumExe, flags);

    appiumProc = spawn(cmd, flags);

    appiumProc.stdout.on('data', (output) => {
      const line = output.toString().trim();

      const regStr = `started on (0\\.0\\.0\\.0|${server.host})\\:${server.port}$`;
      const isRunning = new RegExp(regStr, 'g').test(line);

      if (isRunning) {
        logger.info(
          `Local Appium server started on ${server.host}:${server.port}`,
        );
        done();
      }

      const isShutDown = line === '[Appium] Received SIGTERM - shutting down';
      if (isShutDown) {
        logger.info('Appium server shutting down ...');
      }
    });

    appiumProc.stderr.on('data', (output) => {
      logger.error(output.toString());
    });

    appiumProc.on('exit', () => {
      logger.info('DONE');
    });

    appiumProc.on('error', (err) => {
      logger.error(err.stack);
    });
  }

  /**
		a wrapper to kill the spawned local appium server process.

		NOTE: running appiumProc.kill() on windows only kills the parent, which orphans its child processes.
		'taskkill' should kill the parent and it's children.
	*/
  static killAppium() {
    if (os.platform() === 'win32') {
      logger.info('Appium server shutting down ...');
      spawn('taskkill', ['/PID', appiumProc.pid, '/T', '/F']);
    } else {
      appiumProc.kill();
    }
  }

  /**
		if --use-sdk flag is used, then the following will occur:
			1. Run 'appc ti sdk select <ti_sdk>', regardless if the ti sdk is already selected
			2. Modify and save the target tiapp.xml with <ti_sdk>
			3. Run 'appc ti clean' per platform
			4. Then, run 'appc run --build-only' per platform

		this method assumes that the machine has appc cli installed and logged in.

		@param {Array} suites - the data structure from transform() method
		@param {String} tiSdk - titanium sdk passed with the --use-sdk flag
		@param {Boolean} moreLogs - if --more-logs flag is passed, then print out the ChildProcess's stdout and stderr
		@param {Function} done - the promise resolve function to call once the task is done
	*/
  // eslint-disable-next-line consistent-return
  static buildTestApps(app, suites, tiSdk, moreLogs, done) {
    // eslint-disable-next-line global-require
    const configTests = require(`../ui-tests/${app}/config`);

    // modify the tiapp.xml with the specified titanium sdk from --use-sdk flag
    function change(tiappXml) {
      let xml = fs.readFileSync(tiappXml, { encoding: 'utf8' }).trim();

      const oldSdkXml = xml.match(/<sdk-version>.+<\/sdk-version>/g)[0];
      const newSdkXml = `<sdk-version>${tiSdk}</sdk-version>`;

      xml = xml.replace(oldSdkXml, newSdkXml);
      fs.writeFileSync(tiappXml, xml);
    }

    function spawnCb(output) {
      if (moreLogs) {
        logger.info(output.toString().trim());
      }
    }

    // run different appc commands
    function appc(flags, next) {
      let appcExe = 'appc';
      let appcFlags = flags;

      if (os.platform() === 'win32') {
        // use the windows compatible appc cli script
        appcExe += '.cmd';
      }

      // no fancy stuff
      appcFlags = appcFlags.concat('--no-banner', '--no-services');

      const cmd = spawnConvert(appcExe, appcFlags);

      // assume that the machine has appc cli and is already logged in
      logger.info(`Running: '${cmd} ${appcFlags.join(' ')}' ...`);
      const appcCmd = spawn(cmd, appcFlags);

      // appc cli will print to stdout and stderr regardless of severity
      // hence, using the same callback
      appcCmd.stdout.on('data', spawnCb);
      appcCmd.stderr.on('data', spawnCb);

      appcCmd.on('exit', () => {
        logger.info('done');
        next();
      });
    }

    // if --use-sdk flag was not called, do nothing
    if (!tiSdk) {
      return done();
    }

    // in test_config.js, the same titanium/alloy app can appear per platform per suite.
    // so, will need to track which project's tiapp.xml has already been modified
    const tiappMod = {};

    let p = new Promise((resolve) => {
      // run 'appc ti sdk select' regardless if the correct ti sdk is selected
      appc(['ti', 'sdk', 'select', tiSdk], resolve);
    });

    suites.forEach((targetSuite) => {
      p = p
        .then(() => {
          const tiProj =
            configTests[targetSuite.platform][targetSuite.name].proj;
          const tiProjDir = getAbsolutePath(app, path.join(targetSuite.name, tiProj));

          // only change the tiapp.xml if it hasn't been modified
          if (!tiappMod[tiProj]) {
            tiappMod[tiProj] = true;
            const tiappXmlFile = path.join(tiProjDir, 'tiapp.xml');
            change(tiappXmlFile);
          }

          // this will be used by other appc commands; passing it down the promise chain
          return tiProjDir;
        })
        .then((tiProjDir) => {
          return new Promise((resolve) => {
            // run 'appc ti clean' and target only the specified platform suite
            // shouldn't clean the build directory needlessly because the other built app is probably still good
            appc(
              [
                'ti',
                'clean',
                '--platforms',
                targetSuite.platform,
                '--project-dir',
                tiProjDir,
              ],
              resolve,
            );
          }).then(() => {
            return tiProjDir;
          });
        })
        .then((tiProjDir) => {
          // run 'appc run --build-only'; for simulator/emulator only
          return new Promise((resolve) => {
            appc(
              [
                'run',
                '--platform',
                targetSuite.platform,
                '--project-dir',
                tiProjDir,
                '--build-only',
              ],
              resolve,
            );
          });
        });
    });

    // don't need a Promise.catch() here; the outer promise will catch errors
    p.then(() => {
      done();
    });
  }

  /**
		using the suite data structure from transform() method, generate a list of mocha suite
		and appium capabilities pair.

		@param {Array} suites - the data structure returned from transform() method
		@return {Array} - an array of json objects; the object properies are defined as:
		 	{
				suite: absolute path to the test suite in the TEST_DIR,
				cap: valid appium's capabilities; https://github.com/appium/appium/blob/master/docs/en/writing-running-appium/default-capabilities-arg.md
			}
	*/
  static createTests(app, suites) {
    // eslint-disable-next-line global-require
    const configTests = require(`../ui-tests/${app}/config`);

    const listOfTests = [];

    suites.forEach((targetSuite) => {
      const tests = configTests[targetSuite.platform];
      const desiredCap = tests.desiredCapabilities;
      const configSuite = tests[targetSuite.name];

      const tiBuildDir = path.join(targetSuite.name, configSuite.proj, 'build');

      if (targetSuite.platform === 'ios') {
        desiredCap.platformName = 'iOS';

        // appium needs an absolute path to the specified built mobile app (simulator only for now)
        const iosApp = path.join(
          tiBuildDir,
          'iphone',
          'build',
          'Products',
          'Debug-iphonesimulator',
          `${configSuite.proj}.app`,
        );
        desiredCap.app = getAbsolutePath(app, iosApp);
      } else if (targetSuite.platform === 'android') {
        desiredCap.platformName = 'Android';

        // for android, appium requires these two properties
        desiredCap.appPackage = configSuite.appPackage;
        desiredCap.appActivity = configSuite.appActivity;

        // appium needs an absolute path to the specified built mobile app
        const androidApk = path.join(
          tiBuildDir,
          'android',
          'bin',
          `${configSuite.proj}.apk`,
        );
        desiredCap.app = getAbsolutePath(app, androidApk);
      } else if (targetSuite.platform === 'windows') {
        // NOTE: don't know the actually appium value
        desiredCap.platformName = 'Windows';
      }

      // it is possible for a test suite to have multiple target test devices
      configSuite.testDevices.forEach((device) => {
        // Object.assign() makes a shallow copy (propertry and values only) of desiredCap object
        const newDesires = Object.assign({}, desiredCap);
        newDesires.deviceName = device.deviceName;
        newDesires.platformVersion = device.platformVersion;

        listOfTests.push({
          suite: targetSuite.abs,
          cap: newDesires,
        });
      });
    });

    return listOfTests;
  }

  /**
		launch the specified genymotion emulator if it is defined in your genymotion app.

		NOTE: this assumes that you have genymotion and virtualbox installed on the machine and in the default location.

		@param {String} genyDevice - the genymotion emulator used for testing
		@param {Function} done - the Promise resolve function; called only when this task is done
		@param {Function} stop - the Promise reject function; called when runtime errors appear in this promise chain
	*/
  static launchGeny(genyDevice, done, stop) {
    logger.info(`Launching Genymotion emulator: ${genyDevice} ...`);

    // check if the specified genymotion emulator is in genymotion app
    new Promise((resolve, reject) => {
      let vboxManageExe = 'VBoxManage';
      if (os.platform() === 'win32') {
        // need to get absolute path to VBoxManage.exe
        vboxManageExe = path.join(
          process.env.VBOX_MSI_INSTALL_PATH,
          'VBoxManage.exe',
        );
      }

      const listVmsCmd = spawn(vboxManageExe, ['list', 'vms']);

      let output = '';
      listVmsCmd.stdout.on('data', (chunk) => {
        output += chunk;
      });

      listVmsCmd.stderr.on('data', (error) => {
        logger.error(error.toString());
      });

      listVmsCmd.on('exit', () => {
        const regExp = new RegExp(`^"${genyDevice}"`, 'm');
        const deviceExist = regExp.test(output.trim());

        if (!deviceExist) {
          reject(
            new Error(
              `"${genyDevice}" doesn't exist; make sure to add it in genymotion.`,
            ),
          );
          return;
        }
        resolve();
      });
    })
      .then(() => {
        return new Promise((resolve) => {
          // player executable should be in the default install location (hopefully)
          const player =
            os.platform() === 'win32'
              ? 'C:\\Program Files\\Genymobile\\Genymotion\\player.exe'
              : '/Applications/Genymotion.app/Contents/MacOS/player.app/Contents/MacOS/player';

          // launch genymotion emulator via player
          const flags = ['--vm-name', genyDevice];
          const playerCmd = spawn(player, flags);
          playerPid = playerCmd.pid;

          // the spawned player prints to stdout and stderr, but the correct log information won't appear until you manually kill genymotion emulator.
          // so, going to use a ReadStream; seems faster than using fs.readFileSync
          const genymobileDir =
            os.platform() === 'win32'
              ? path.join(process.env.LOCALAPPDATA, 'Genymobile')
              : path.join(os.homedir(), '.Genymobile');

          const playerLog = path.join(
            genymobileDir,
            'Genymotion',
            'deployed',
            genyDevice,
            'genymotion-player.log',
          );

          // sometimes, genymotion-player.log will not exist because genymotion have not been ran yet on the machine.
          // this will wait for the log file to be created so we can watch it.
          let logExist = null;
          while (!logExist) {
            try {
              logExist = fs.statSync(playerLog);
            } catch (err) {
              /* do nothing */
            }
          }

          fs.watchFile(playerLog, () => {
            const stream = fs.createReadStream(playerLog);

            stream.on('data', (output) => {
              const matches = output
                .toString()
                .trim()
                .match(
                  /\d+-\d+-\d+T\d+:\d+:\d+\+\d+:\d+ \[Genymotion Player:\d+\] \[debug\] Device booted in \d+ ms/g,
                );
              if (matches) {
                // try to grab the last line from the file
                const lastLine = matches[matches.length - 1];

                // capture the timestamp that is prefixed in the log per line
                const dateTime = lastLine.match(
                  /\d+-\d+-\d+T\d+:\d+:\d+\+\d+:\d+/g,
                );

                const logTime = Date.parse(dateTime);
                const deltaTime = Date.now() - logTime;

                // if the timestamp is within 10 second of current time and log ends with 'Device booted in' (launched), then move to next task
                if (
                  deltaTime <= 10000 &&
                  /Device booted in .+/g.test(lastLine)
                ) {
                  fs.unwatchFile(playerLog);
                  resolve();
                }
              }
            });
          });
        });
      })
      .then(() => {
        done();
      })
      .catch((err) => {
        stop(err);
      });
  }

  /**
		kills the genymotion emulator by running:
		- applescript on macOS: 'quit app "player"'
		- vbscript on Windows: look at vbScript

		if you were to send kill signals to the "player" process (from launchGeny()),
		then genymotion will not be able to handle those signals, i.e. the player process will be killed,
		but the VBox processes will still be alive and "adb devices" will persist the android emulator (both launched by "player").
		this will cause the next launch of genymotion emulator to be more likely to be unsuccessful.

		by running these external commands, they will make genymotion emulator die gracefully.

		@param {Function} done - Promise resolve function to call when this task is done
	*/
  static quitGeny(done) {
    let cmd = 'osascript';
    let flags = ['-e', 'quit app "player"'];

    if (os.platform() === 'win32') {
      const vbScript = `
Set WshShell = WScript.CreateObject("WScript.Shell")
WshShell.AppActivate ${playerPid}
WshShell.SendKeys "%{F4}"`;

      const vbFile = path.join(__dirname, 'kill_geny.vbs');
      fs.writeFileSync(vbFile, vbScript);

      flags = [];
      cmd = spawnConvert(vbFile, flags);
    }

    spawn(cmd, flags).on('exit', () => {
      done();
    });
  }
}

module.exports = Helper;
