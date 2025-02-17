import { expect } from 'chai';
// we are using custom plugin harness as we want to run two instance of device-farm simultaneously
import { pluginE2EHarness } from '../plugin-harness';
import { remote } from 'webdriverio';
import {
  HUB_APPIUM_PORT,
  NODE_APPIUM_PORT,
  PLUGIN_PATH,
  ensureAppiumHome,
  ensureHubConfig,
  ensureNodeConfig,
} from '../e2ehelper';
import { Options } from '@wdio/types';
import axios from 'axios';
import { default as chaiAsPromised } from 'chai-as-promised';
import * as chai from 'chai';
import { hub_config, node_config } from '../e2ehelper';
chai.use(chaiAsPromised);

let driver: any;

const WDIO_PARAMS = {
  connectionRetryCount: 0,
  hostname: hub_config.bindHostOrIp,
  port: HUB_APPIUM_PORT,
  logLevel: 'info',
  path: '/',
};

let hubReady = false;
let nodeReady = false;

const capabilities = {
  'appium:automationName': 'UiAutomator2',
  'appium:app': 'https://prod-mobile-artefacts.lambdatest.com/assets/docs/proverbial_android.apk',
  platformName: 'android',
  'appium:deviceName': '',
  'appium:uiautomator2ServerInstallTimeout': 90000,
} as unknown as WebdriverIO.Capabilities;

const NEW_COMMAND_TIMEOUT_SECS = 10;

describe('E2E Forward Request', () => {
  console.log('Before all');
  // dump hub config into a file
  const hub_config_file = ensureHubConfig('android', 'real', 'real', {
    newCommandTimeoutSec: NEW_COMMAND_TIMEOUT_SECS,
  });

  // dump node config into a file
  const node_config_file = ensureNodeConfig();

  // setup appium home
  const APPIUM_HOME = ensureAppiumHome('hub', true);

  const APPIUM_HOME_NODE = ensureAppiumHome('node', true);

  console.log(`Hub config file: ${hub_config_file}`);

  // run hub
  const hubProcess = pluginE2EHarness({
    before: undefined,
    after: global.after,
    configFile: hub_config_file,
    pluginName: 'device-farm',
    host: hub_config.bindHostOrIp,
    port: HUB_APPIUM_PORT,
    driverSource: 'npm',
    driverName: 'uiautomator2',
    driverSpec: 'appium-uiautomator2-driver',
    pluginSource: 'local',
    pluginSpec: PLUGIN_PATH,
    appiumHome: APPIUM_HOME!,
  });

  // run node
  const nodeProcess = pluginE2EHarness({
    before: undefined,
    after: global.after,
    configFile: node_config_file,
    pluginName: 'device-farm',
    port: NODE_APPIUM_PORT,
    host: node_config.bindHostOrIp,
    driverSource: 'npm',
    driverName: 'uiautomator2',
    driverSpec: 'appium-uiautomator2-driver',
    pluginSource: 'local',
    pluginSpec: PLUGIN_PATH,
    appiumHome: APPIUM_HOME_NODE!,
  });

  async function waitForHubAndNode() {
    if (!hubReady) {
      console.log('Waiting for hub to be ready');
      await hubProcess.startPlugin();
      hubReady = true;
    }

    if (!nodeReady) {
      console.log('Waiting for node to be ready');
      await nodeProcess.startPlugin();
      nodeReady = true;
    }
  }

  it('node can handle appium request on its own (hub still need to run)', async () => {
    await waitForHubAndNode();
    const node_wdio_params = Object.assign({}, WDIO_PARAMS, {
      hostname: node_config.bindHostOrIp,
      port: NODE_APPIUM_PORT,
    });
    console.log(`Node wdio params: ${JSON.stringify(node_wdio_params)}`);
    console.log(`node config: ${JSON.stringify(node_config)}`);
    driver = await remote({ ...node_wdio_params, capabilities } as Options.WebdriverIO);
    expect(driver).to.be.not.undefined;
  });

  it('can forward session request to node', async () => {
    await waitForHubAndNode();
    if (hub_config.bindHostOrIp == node_config.bindHostOrIp) {
      it.skip('node and hub should not be using the same host');
    }

    // hub and node should be running
    const hub_url = `http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}`;
    const node_url = `http://${node_config.bindHostOrIp}:${NODE_APPIUM_PORT}`;

    console.log(`Hub url: ${hub_url}`);

    expect(axios.get(`${hub_url}/device-farm`)).to.eventually.equal(200, 'hub should be running');
    expect(axios.get(`${node_url}/device-farm`)).to.eventually.equal(200, 'node should be running');

    // all devices
    const allDevices = (
      await axios.get(`http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}/device-farm/api/device`)
    ).data;

    // there should be at least one device
    // expect(allDevices.length).to.be.greaterThan(0);

    // wait until there is at least one device

    // one of the device should come from node
    const nodeDevice = allDevices.filter(
      (device: any) => device.host?.includes(node_config.bindHostOrIp),
    );

    expect(nodeDevice).to.not.be.undefined;

    console.log(`Node device: ${JSON.stringify(nodeDevice)}`);

    driver = await remote({ ...WDIO_PARAMS, capabilities } as Options.WebdriverIO);

    // busy device should be on the node
    const newAllDevices = (
      await axios.get(`http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}/device-farm/api/device`)
    ).data;
    const busyDevice = newAllDevices.filter((device: any) => device.busy);

    // device should have host as node_config.bindHostOrIp
    expect(busyDevice[0]).to.have.property('host').that.includes(node_config.bindHostOrIp);
    expect(busyDevice[0]).to.have.property('host').that.not.includes(hub_config.bindHostOrIp);
  });

  it('update lastCmdExecutedAt when forwarding request', async () => {
    await waitForHubAndNode();
    if (hub_config.bindHostOrIp == node_config.bindHostOrIp) {
      it.skip('node and hub should not be using the same host');
    }

    driver = await remote({ ...WDIO_PARAMS, capabilities } as Options.WebdriverIO);
    const allDevices = (
      await axios.get(`http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}/device-farm/api/device`)
    ).data;

    const busyDevice = allDevices.filter((device: any) => device.busy);
    const lastCmdExecutedAt = busyDevice[0].lastCmdExecutedAt;

    // lastCmdExecutedAt should not be empty
    expect(lastCmdExecutedAt).to.not.be.undefined;

    // run a command
    await driver.getPageSource();

    // check lastCmdExecutedAt
    const newAllDevices = (
      await axios.get(`http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}/device-farm/api/device`)
    ).data;
    const newBusyDevice = newAllDevices.filter(
      (device: any) => device.udid === busyDevice[0].udid && device.host === busyDevice[0].host,
    );
    const newLastCmdExecutedAt = newBusyDevice[0].lastCmdExecutedAt;

    // lastCmdExecutedAt should not be empty
    expect(newLastCmdExecutedAt).to.not.be.undefined;

    // lastCmdExecutedAt should be greater than the previous one
    expect(newLastCmdExecutedAt).to.be.greaterThan(lastCmdExecutedAt);

    // print out the device
    console.log(`Busy device: ${JSON.stringify(newBusyDevice)}`);
  });

  it.only('does not unblock device when cmd is sent before newCommandTimeoutSec', async () => {
    await waitForHubAndNode();
    if (hub_config.bindHostOrIp == node_config.bindHostOrIp) {
      it.skip('node and hub should not be using the same host');
    }

    driver = await remote({ ...WDIO_PARAMS, capabilities } as Options.WebdriverIO);
    const allDevices = (
      await axios.get(`http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}/device-farm/api/device`)
    ).data;

    const busyDevice = allDevices.filter((device: any) => device.busy);

    // keep sending command every 5 seconds for 20 seconds
    const interval = setInterval(async () => {
      await driver.getPageSource();
    }, 5000);

    // wait for 20 seconds
    await new Promise((resolve) => setTimeout(resolve, (NEW_COMMAND_TIMEOUT_SECS + 10) * 1000));
    clearInterval(interval);

    // check device status
    const newAllDevices = (
      await axios.get(`http://${hub_config.bindHostOrIp}:${HUB_APPIUM_PORT}/device-farm/api/device`)
    ).data;

    const newBusyDevice = newAllDevices.filter(
      (device: any) => device.udid === busyDevice[0].udid && device.host === busyDevice[0].host,
    );

    // device should be busy
    expect(newBusyDevice[0].busy).to.be.true;
  });

  afterEach(async function () {
    if (driver !== undefined) {
      await driver.deleteSession();
      driver = undefined;
    }
  });
});
