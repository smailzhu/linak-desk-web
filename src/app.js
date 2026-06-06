const UUIDS = {
  controlService: '99fa0001-338a-1024-8a49-009c0215f78a',
  controlCommand: '99fa0002-338a-1024-8a49-009c0215f78a',
  dpgService: '99fa0010-338a-1024-8a49-009c0215f78a',
  dpgCommand: '99fa0011-338a-1024-8a49-009c0215f78a',
  referenceOutputService: '99fa0020-338a-1024-8a49-009c0215f78a',
  referenceOutputOne: '99fa0021-338a-1024-8a49-009c0215f78a',
  referenceInputService: '99fa0030-338a-1024-8a49-009c0215f78a',
  referenceInputOne: '99fa0031-338a-1024-8a49-009c0215f78a',
};

const COMMANDS = {
  moveDown: 70,
  moveUp: 71,
  wakeup: 254,
  stop: 255,
};

const DPG_COMMANDS = {
  capabilities: 128,
  baseOffset: 129,
  userId: 134,
};

const DEFAULT_PRESETS = [
  { name: 'Sit', height: 760 },
  { name: 'Stand', height: 1100 },
];

const storage = {
  get baseHeight() {
    return Number(localStorage.getItem('linak.baseHeight')) || 620;
  },
  set baseHeight(value) {
    localStorage.setItem('linak.baseHeight', String(value));
  },
  get commandPeriod() {
    return Number(localStorage.getItem('linak.commandPeriod')) || 400;
  },
  set commandPeriod(value) {
    localStorage.setItem('linak.commandPeriod', String(value));
  },
  get presets() {
    const saved = localStorage.getItem('linak.presets');
    return saved ? JSON.parse(saved) : DEFAULT_PRESETS;
  },
  set presets(value) {
    localStorage.setItem('linak.presets', JSON.stringify(value));
  },
};

class LinakDesk {
  device = null;
  server = null;
  chars = {};
  baseHeight = storage.baseHeight;
  moveTimer = null;
  movingToTarget = false;
  dpgNotificationsStarted = false;
  heightNotificationsStarted = false;
  disconnecting = false;
  lastReading = null;
  onDisconnect = () => {};
  onReading = () => {};
  onLog = () => {};

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser.');
    }

    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        UUIDS.controlService,
        UUIDS.dpgService,
        UUIDS.referenceOutputService,
        UUIDS.referenceInputService,
      ],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this.clearMoveTimer();
      if (this.disconnecting) {
        this.disconnecting = false;
        return;
      }
      this.onDisconnect();
    });

    this.dpgNotificationsStarted = false;
    this.heightNotificationsStarted = false;
    this.disconnecting = false;

    try {
      this.server = await this.withConnectStep('connecting to GATT server', () => this.device.gatt.connect());
      await delay(250);
      await this.loadCharacteristics();
      await this.startHeightNotifications().catch((error) => {
        this.onLog(`Live updates unavailable: ${error.message}`);
      });
      await this.initialiseDpg();
      await this.withConnectStep('reading height', () => this.refreshHeight());
    } catch (error) {
      if (this.device.gatt.connected) {
        this.disconnecting = true;
        this.device.gatt.disconnect();
      }
      throw error;
    }

    return this.device;
  }

  async disconnect() {
    this.clearMoveTimer();
    this.movingToTarget = false;
    if (this.isConnected()) {
      await this.stop();
      this.disconnecting = true;
      this.device.gatt.disconnect();
    }
  }

  isConnected() {
    return Boolean(this.device?.gatt?.connected);
  }

  async loadCharacteristics() {
    const control = await this.withConnectStep('finding control service', () =>
      this.server.getPrimaryService(UUIDS.controlService)
    );
    const controlCommand = await this.withConnectStep('finding control command', () =>
      control.getCharacteristic(UUIDS.controlCommand)
    );

    await delay(100);

    const output = await this.withConnectStep('finding height output service', () =>
      this.server.getPrimaryService(UUIDS.referenceOutputService)
    );
    const referenceOutputOne = await this.withConnectStep('finding height output', () =>
      output.getCharacteristic(UUIDS.referenceOutputOne)
    );

    await delay(100);

    const input = await this.withConnectStep('finding height input service', () =>
      this.server.getPrimaryService(UUIDS.referenceInputService)
    );
    const referenceInputOne = await this.withConnectStep('finding height input', () =>
      input.getCharacteristic(UUIDS.referenceInputOne)
    );

    await delay(100);

    const dpg = await this.withConnectStep('finding DPG service', () =>
      this.server.getPrimaryService(UUIDS.dpgService)
    );
    const dpgCommand = await this.withConnectStep('finding DPG command', () =>
      dpg.getCharacteristic(UUIDS.dpgCommand)
    );

    this.chars = {
      controlCommand,
      dpgCommand,
      referenceOutputOne,
      referenceInputOne,
    };
  }

  async withConnectStep(step, operation) {
    this.onLog(`Connecting: ${step}.`);
    try {
      return await operation();
    } catch (error) {
      throw new Error(`${step} failed: ${error.message || error}`);
    }
  }

  async initialiseDpg() {
    await this.tryReadBaseHeight();
    await this.trySetUserId();
  }

  async tryReadBaseHeight() {
    try {
      const response = await this.dpgCommand(DPG_COMMANDS.baseOffset);
      if (response?.byteLength >= 3) {
        const rawBaseOffset = response.getUint16(1, true);
        const baseHeight = Math.round(rawBaseOffset / 10);
        if (baseHeight >= 500 && baseHeight <= 900) {
          this.baseHeight = baseHeight;
          storage.baseHeight = baseHeight;
        }
      }
    } catch (error) {
      this.onLog(`Using saved base height: ${this.baseHeight} mm`);
    }
  }

  async trySetUserId() {
    try {
      const response = await this.dpgCommand(DPG_COMMANDS.userId);
      if (!response?.byteLength || response.getUint8(0) === 1) {
        return;
      }
      const userId = new Uint8Array(response.buffer.slice(0));
      userId[0] = 1;
      await this.dpgCommand(DPG_COMMANDS.userId, userId);
    } catch (error) {
      this.onLog('Skipped DPG user id update.');
    }
  }

  dpgCommand(command, payload) {
    return new Promise(async (resolve, reject) => {
      const char = this.chars.dpgCommand;
      const timeout = window.setTimeout(() => {
        char.removeEventListener('characteristicvaluechanged', handleResponse);
        reject(new Error(`DPG command ${command} timed out.`));
      }, 1200);

      const handleResponse = (event) => {
        const value = event.target.value;
        window.clearTimeout(timeout);
        char.removeEventListener('characteristicvaluechanged', handleResponse);

        if (value.byteLength && value.getUint8(0) === 1) {
          resolve(sliceDataView(value, 2));
        } else {
          resolve(null);
        }
      };

      try {
        char.addEventListener('characteristicvaluechanged', handleResponse);
        if (!this.dpgNotificationsStarted) {
          await char.startNotifications();
          this.dpgNotificationsStarted = true;
        }

        if (payload) {
          const buffer = new Uint8Array(3 + payload.byteLength);
          buffer[0] = 0x7f;
          buffer[1] = command;
          buffer[2] = 0x80;
          buffer.set(payload, 3);
          await char.writeValue(buffer);
        } else {
          await char.writeValue(new Uint8Array([0x7f, command, 0]));
          await char.readValue().catch(() => null);
        }
      } catch (error) {
        window.clearTimeout(timeout);
        char.removeEventListener('characteristicvaluechanged', handleResponse);
        reject(error);
      }
    });
  }

  async startHeightNotifications() {
    const char = this.chars.referenceOutputOne;
    if (this.heightNotificationsStarted) {
      return;
    }
    char.addEventListener('characteristicvaluechanged', (event) => {
      this.publishReading(this.decodeHeightSpeed(event.target.value));
    });
    await char.startNotifications();
    this.heightNotificationsStarted = true;
  }

  async refreshHeight() {
    const value = await this.chars.referenceOutputOne.readValue();
    const reading = this.decodeHeightSpeed(value);
    this.publishReading(reading);
    return reading;
  }

  decodeHeightSpeed(value) {
    const rawHeight = value.getUint16(0, true);
    const rawSpeed = value.getInt16(2, true);
    return {
      rawHeight,
      rawSpeed,
      height: Math.round(rawHeight / 10 + this.baseHeight),
      speed: rawSpeed / 100,
    };
  }

  publishReading(reading) {
    this.lastReading = reading;
    this.onReading(reading);
  }

  async wakeup() {
    await this.writeCommand(COMMANDS.wakeup);
  }

  async stop() {
    this.clearMoveTimer();
    await this.writeCommand(COMMANDS.stop);
  }

  async startManualMove(direction) {
    this.clearMoveTimer();
    await this.wakeup();
    const command = direction === 'up' ? COMMANDS.moveUp : COMMANDS.moveDown;
    const write = () => this.writeCommand(command).catch((error) => this.onLog(error.message));
    await write();
    this.moveTimer = window.setInterval(write, storage.commandPeriod);
  }

  async moveTo(heightMm) {
    const target = Math.round((heightMm - this.baseHeight) * 10);
    if (target < 0 || target > 65535) {
      throw new Error(`Target ${heightMm} mm is outside the supported desk range.`);
    }

    this.clearMoveTimer();
    this.movingToTarget = true;
    await this.wakeup();
    await this.writeCommand(COMMANDS.stop);

    const targetBuffer = new Uint8Array(2);
    new DataView(targetBuffer.buffer).setUint16(0, target, true);

    let stableReads = 0;
    let lastHeight = null;
    const startedAt = Date.now();

    while (this.movingToTarget) {
      await this.chars.referenceInputOne.writeValue(targetBuffer);
      await delay(storage.commandPeriod);
      const reading = await this.refreshHeight();

      if (Math.abs(reading.height - heightMm) <= 2) {
        stableReads += 1;
      } else if (lastHeight === reading.height && reading.speed === 0) {
        stableReads += 1;
      } else {
        stableReads = 0;
      }

      if (stableReads >= 2 || Date.now() - startedAt > 45000) {
        break;
      }

      lastHeight = reading.height;
    }

    this.movingToTarget = false;
    await this.writeCommand(COMMANDS.stop);
    return this.refreshHeight();
  }

  cancelTargetMove() {
    this.movingToTarget = false;
  }

  async writeCommand(command) {
    await this.chars.controlCommand.writeValue(new Uint8Array([command, 0]));
  }

  clearMoveTimer() {
    if (this.moveTimer) {
      window.clearInterval(this.moveTimer);
      this.moveTimer = null;
    }
  }
}

const elements = {
  connectButton: document.querySelector('#connectButton'),
  disconnectButton: document.querySelector('#disconnectButton'),
  deviceName: document.querySelector('#deviceName'),
  heightValue: document.querySelector('#heightValue'),
  speedValue: document.querySelector('#speedValue'),
  baseHeightValue: document.querySelector('#baseHeightValue'),
  upButton: document.querySelector('#upButton'),
  downButton: document.querySelector('#downButton'),
  stopButton: document.querySelector('#stopButton'),
  moveForm: document.querySelector('#moveForm'),
  targetHeight: document.querySelector('#targetHeight'),
  moveButton: document.querySelector('#moveButton'),
  savePresetButton: document.querySelector('#savePresetButton'),
  presetList: document.querySelector('#presetList'),
  presetTemplate: document.querySelector('#presetTemplate'),
  baseHeight: document.querySelector('#baseHeight'),
  commandPeriod: document.querySelector('#commandPeriod'),
  statusMessage: document.querySelector('#statusMessage'),
  log: document.querySelector('#log'),
};

const desk = new LinakDesk();

desk.onDisconnect = () => {
  setConnected(false);
  log('Disconnected.');
};

desk.onReading = (reading) => {
  elements.heightValue.textContent = String(reading.height);
  elements.speedValue.textContent = formatSpeed(reading.speed);
  elements.baseHeightValue.textContent = String(desk.baseHeight);
  elements.baseHeight.value = String(desk.baseHeight);
};

desk.onLog = log;

elements.baseHeight.value = String(storage.baseHeight);
elements.commandPeriod.value = String(storage.commandPeriod);
elements.baseHeightValue.textContent = String(storage.baseHeight);
renderPresets();
setConnected(false);

elements.connectButton.addEventListener('click', async () => {
  try {
    setBusy(true);
    log('Opening Bluetooth picker.');
    const device = await desk.connect();
    elements.deviceName.textContent = device.name || 'LINAK desk';
    setConnected(true);
    log('Connected.', 'success');
  } catch (error) {
    setConnected(false);
    log(`Connection error: ${formatConnectionError(error)}`, 'error');
  } finally {
    setBusy(false);
  }
});

elements.disconnectButton.addEventListener('click', async () => {
  await desk.disconnect();
  setConnected(false);
  log('Disconnected.');
});

elements.stopButton.addEventListener('click', async () => {
  desk.cancelTargetMove();
  await desk.stop();
  await desk.refreshHeight().catch(() => null);
  log('Stopped.');
});

bindHoldButton(elements.upButton, 'up');
bindHoldButton(elements.downButton, 'down');

elements.moveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const height = Number(elements.targetHeight.value);
  if (!height) {
    return;
  }
  await moveTo(height);
});

elements.savePresetButton.addEventListener('click', () => {
  const height = desk.lastReading?.height;
  if (!height) {
    return;
  }
  const name = window.prompt('Preset name', `${height} mm`);
  if (!name) {
    return;
  }
  const presets = storage.presets.filter((preset) => preset.name !== name);
  presets.push({ name, height });
  storage.presets = presets;
  renderPresets();
});

elements.baseHeight.addEventListener('change', () => {
  const value = Number(elements.baseHeight.value);
  if (!value) {
    return;
  }
  desk.baseHeight = value;
  storage.baseHeight = value;
  elements.baseHeightValue.textContent = String(value);
  if (desk.lastReading) {
    desk.publishReading(desk.decodeHeightSpeed(readingToDataView(desk.lastReading)));
  }
});

elements.commandPeriod.addEventListener('change', () => {
  const value = Number(elements.commandPeriod.value);
  if (value) {
    storage.commandPeriod = value;
  }
});

async function moveTo(height) {
  try {
    setBusy(true);
    log(`Moving to ${height} mm.`);
    const reading = await desk.moveTo(height);
    log(`Height ${reading.height} mm.`, 'success');
  } catch (error) {
    log(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function bindHoldButton(button, direction) {
  const stop = async () => {
    if (!desk.isConnected()) {
      return;
    }
    await desk.stop().catch((error) => log(error.message));
    await desk.refreshHeight().catch(() => null);
  };

  button.addEventListener('pointerdown', async (event) => {
    event.preventDefault();
    if (!desk.isConnected()) {
      return;
    }
    button.setPointerCapture(event.pointerId);
    await desk.startManualMove(direction).catch((error) => log(error.message));
  });

  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('lostpointercapture', stop);
}

function renderPresets() {
  elements.presetList.replaceChildren();
  storage.presets.forEach((preset, index) => {
    const node = elements.presetTemplate.content.cloneNode(true);
    const moveButton = node.querySelector('.preset-move');
    const deleteButton = node.querySelector('.preset-delete');

    moveButton.textContent = `${preset.name} ${preset.height} mm`;
    moveButton.disabled = !desk.isConnected();
    moveButton.addEventListener('click', () => moveTo(preset.height));

    deleteButton.addEventListener('click', () => {
      const presets = storage.presets;
      presets.splice(index, 1);
      storage.presets = presets;
      renderPresets();
    });

    elements.presetList.append(node);
  });
}

function setConnected(connected) {
  elements.connectButton.disabled = connected;
  elements.disconnectButton.disabled = !connected;
  elements.upButton.disabled = !connected;
  elements.downButton.disabled = !connected;
  elements.stopButton.disabled = !connected;
  elements.targetHeight.disabled = !connected;
  elements.moveButton.disabled = !connected;
  elements.savePresetButton.disabled = !connected;

  if (!connected) {
    elements.deviceName.textContent = 'No desk connected';
  }

  renderPresets();
}

function setBusy(busy) {
  elements.connectButton.disabled = busy || desk.isConnected();
  elements.moveButton.disabled = busy || !desk.isConnected();
  elements.disconnectButton.disabled = busy || !desk.isConnected();
  elements.savePresetButton.disabled = busy || !desk.isConnected();
}

function log(message, type = 'info') {
  elements.statusMessage.className = `status-message ${type === 'info' ? '' : type}`.trim();
  elements.statusMessage.textContent = message;
  elements.log.textContent = message;
}

function formatConnectionError(error) {
  const message = String(error?.message || error).replace(/^connection error:\s*/i, '');
  if (/gatt operation failed/i.test(message)) {
    return `${message}. Put the desk back in pairing mode, make sure no phone app is connected, then retry.`;
  }
  return message;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatSpeed(speed) {
  if (Number.isInteger(speed)) {
    return String(speed);
  }
  return speed.toFixed(1);
}

function sliceDataView(value, offset) {
  return new DataView(value.buffer.slice(value.byteOffset + offset, value.byteOffset + value.byteLength));
}

function readingToDataView(reading) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint16(0, reading.rawHeight, true);
  view.setInt16(2, reading.rawSpeed, true);
  return view;
}
