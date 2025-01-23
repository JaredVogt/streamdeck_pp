import { openStreamDeck, listStreamDecks } from '@elgato-stream-deck/node';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';
import fs from 'fs/promises';

const VERSION = "1.0.4";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class StreamDeckController {
    #streamDeck = null;
    #buttonStates = new Map();
    #encoderCallbacks = {
        left: {
            rotate: null,
            press: null,
            release: null
        },
        right: {
            rotate: null,
            press: null,
            release: null
        }
    };
    #chains = [];
    #currentChain = null;
    #buttonTexts = new Map();

    constructor() {
        this.#initialize();
    }

    async #initialize() {
        try {
            const devices = await listStreamDecks();
            console.log('Found devices:', devices);
            
            if (devices.length === 0) {
                throw new Error('No Stream Deck devices found');
            }

            const studioDevice = devices.find(device => 
                device.model.toLowerCase() === 'studio'
            );
            
            if (!studioDevice) {
                throw new Error('No Stream Deck Studio found. Available devices: ' + 
                    devices.map(d => d.model).join(', '));
            }

            console.log('Attempting to connect to:', studioDevice);
            try {
                this.#streamDeck = await openStreamDeck(studioDevice.path);
            } catch (err) {
                console.error('Failed to open Stream Deck. Error:', err);
                console.log('If you have the Stream Deck app running, please close it and try again.');
                throw new Error('Could not open Stream Deck: ' + err.message);
            }
            console.log('Connected to Stream Deck:', this.#streamDeck.MODEL);

            this.#setupEventListeners();
            await this.resetDeck();
        } catch (error) {
            console.error('Error initializing Stream Deck:', error);
        }
    }

    #setupEventListeners() {
        this.#streamDeck.on('down', (keyIndex) => {
            const index = this.#getKeyIndex(keyIndex);
            console.log(`Button ${index} pressed (Stream Deck value: ${JSON.stringify(keyIndex)})`);
            this.#handleKeyPress(keyIndex);
        });

        this.#streamDeck.on('up', (keyIndex) => {
            const index = this.#getKeyIndex(keyIndex);
            console.log(`Button ${index} released (Stream Deck value: ${JSON.stringify(keyIndex)})`);
            this.#handleKeyRelease(keyIndex);
        });

        this.#streamDeck.on('dial', (encoderIndex, value, isPressed) => {
            console.log(`Encoder ${encoderIndex} rotation: ${value} (pressed: ${isPressed}) (Stream Deck value: encoder${encoderIndex})`);
            this.#handleEncoderRotate(encoderIndex, value);
        });

        this.#streamDeck.on('dialDown', encoderIndex => {
            console.log(`Encoder ${encoderIndex} pressed (Stream Deck value: encoder${encoderIndex})`);
            this.#handleEncoderPress(encoderIndex);
        });

        this.#streamDeck.on('dialUp', encoderIndex => {
            console.log(`Encoder ${encoderIndex} released (Stream Deck value: encoder${encoderIndex})`);
            this.#handleEncoderRelease(encoderIndex);
        });
    }

    async resetDeck() {
        if (!this.#streamDeck) return;
        await this.#streamDeck.clearPanel();
        await this.#streamDeck.setBrightness(100);
        this.#buttonStates.clear();
        this.#buttonTexts.clear();
    }

    async setButtonImage(keyIndex, imagePath) {
        try {
            if (!this.#streamDeck) return;

            const image = await sharp(imagePath)
                .resize(this.#streamDeck.ICON_SIZE, this.#streamDeck.ICON_SIZE, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .raw()
                .toBuffer();

            await this.#streamDeck.fillKeyBuffer(keyIndex, image);
        } catch (error) {
            console.error(`Error setting image for button ${keyIndex}:`, error);
        }
    }

    async setButtonText(keyIndex, text, options = {}) {
        const index = this.#getKeyIndex(keyIndex);
        try {
            if (!this.#streamDeck) return;

            const {
                fontSize = 20,
                color = '#ffffff',
                backgroundColor = '#000000',
                cornerRadius = 20,
                midiChannel = null
            } = options;

            let svg = `
                <svg width="144" height="112" xmlns="http://www.w3.org/2000/svg">
                    <rect 
                        width="144" 
                        height="112" 
                        fill="${backgroundColor}"
                        rx="${cornerRadius}"
                        ry="${cornerRadius}"
                    />
                    <text
                        x="50%"
                        y="50%"
                        font-family="Arial"
                        font-size="${fontSize}"
                        fill="${color}"
                        text-anchor="middle"
                        dominant-baseline="middle"
                    >${text}</text>`;

            if (midiChannel !== null) {
                svg += `
                    <text
                        x="95%"
                        y="15%"
                        font-family="Arial"
                        font-size="14"
                        fill="${color}"
                        text-anchor="end"
                        dominant-baseline="middle"
                    >${midiChannel}</text>`;
            }

            svg += `</svg>`;

            const buffer = await sharp(Buffer.from(svg))
                .resize(144, 112)
                .removeAlpha()
                .raw()
                .toBuffer();

            await this.#streamDeck.fillKeyBuffer(index, buffer);
            
            // Store the text associated with this button
            this.#buttonTexts.set(index, text);
            console.log(`Set text for button ${index}: "${text}" ${midiChannel !== null ? `(MIDI: ${midiChannel})` : ''}`);
        } catch (error) {
            console.error(`Error setting text for button ${index}:`, error);
        }
    }

    registerButtonAction(keyIndex, pressCallback, releaseCallback = null, buttonInfo = {}) {
        console.log(`Registering action for button ${keyIndex}:`, JSON.stringify(buttonInfo, null, 2));
        this.#buttonStates.set(Number(keyIndex), {
            pressCallback,
            releaseCallback,
            ...buttonInfo
        });
    }

    #handleKeyPress(keyIndex) {
        const index = this.#getKeyIndex(keyIndex);
        console.log(`Handling key press for button ${index}`);
        if (index === 0) {
            console.log("'Show Chains' button pressed");
            this.showChains();
        } else {
            const buttonText = this.#getButtonText(index);
            console.log(`Button ${index} pressed with text: "${buttonText}"`);
            const chain = this.#chains.find(c => c.name === buttonText);
            if (chain) {
                console.log(`Found chain:`, JSON.stringify(chain, null, 2));
                this.loadChain(chain);
            } else {
                console.log(`No chain found for button ${index} with text: "${buttonText}"`);
                console.log(`Available chains:`, JSON.stringify(this.#chains.map(c => c.name), null, 2));
            }
        }
    }

    #handleKeyRelease(keyIndex) {
        const buttonState = this.#buttonStates.get(Number(keyIndex));
        if (buttonState && buttonState.releaseCallback) {
            console.log(`Button ${keyIndex} released: ${buttonState.name}`);
            console.dir(buttonState, { depth: null });
            buttonState.releaseCallback(keyIndex);
        }
    }

    registerEncoderActions(encoder, { onRotate, onPress, onRelease } = {}) {
        const encoderKey = encoder === 0 ? 'left' : 'right';
        this.#encoderCallbacks[encoderKey] = {
            rotate: onRotate,
            press: onPress,
            release: onRelease
        };
    }

    #handleEncoderRotate(encoder, rotation) {
        const encoderKey = encoder === 0 ? 'left' : 'right';
        this.#encoderCallbacks[encoderKey].rotate?.(rotation);
    }

    #handleEncoderPress(encoder) {
        const encoderKey = encoder === 0 ? 'left' : 'right';
        this.#encoderCallbacks[encoderKey].press?.();
    }

    #handleEncoderRelease(encoder) {
        const encoderKey = encoder === 0 ? 'left' : 'right';
        this.#encoderCallbacks[encoderKey].release?.();
    }

    async loadChainLayout(jsonFilePath) {
        try {
            const jsonData = await fs.readFile(jsonFilePath, 'utf8');
            const data = JSON.parse(jsonData);
            
            this.#chains = Object.values(data.chains).map(chain => ({
                name: chain.state?.name || 'Unnamed Chain',
                id: chain.id,
                midiChannel: chain.state?.midiChannel,
                active: chain.cond?.active || false,
                modules: chain.lanes?.[0].cells?.flatMap(cell => {
                    const items = cell.items?.flatMap(item => 
                        ['L', 'R'].filter(ch => item[ch]).map(ch => ({
                            name: item[ch].name,
                            deviceName: item[ch].device?.name,
                            role: Object.keys(item[ch].role || {})[0],
                            midiNote: item[ch].midi?.note,
                            channel: ch,
                            phonia: item[ch].phonia,
                            tags: item[ch].tags,
                            ab: cell.ab
                        }))
                    ) ?? [];
                    return items;
                }) ?? []
            }));

            if (this.#chains.length === 0) {
                throw new Error('No chains found in the JSON file.');
            }

            await this.showChains();
        } catch (error) {
            console.error('Error loading chain layout:', error);
        }
    }

    #getKeyIndex(keyIndex) {
        if (typeof keyIndex === 'object' && keyIndex !== null) {
            return keyIndex.index;
        }
        return Number(keyIndex);
    }

    #getButtonText(keyIndex) {
        const index = this.#getKeyIndex(keyIndex);
        const text = this.#buttonTexts.get(index);
        console.log(`Retrieved text for button ${index}: "${text}"`);
        return text || `Unknown Button ${index}`;
    }

    async showChains() {
        console.log("Showing chains");
        await this.resetDeck();
        await this.createShowChainsButton();

        console.log(`Total chains: ${this.#chains.length}`);
        for (let i = 0; i < this.#chains.length && i < 31; i++) {
            const chain = this.#chains[i];
            const buttonIndex = i + 1;
            console.log(`Setting up chain button ${buttonIndex}: ${chain.name} (MIDI: ${chain.midiChannel || 'N/A'})`);
            await this.setButtonText(buttonIndex, chain.name, {
                fontSize: 16,
                color: '#ffffff',
                backgroundColor: '#8B4513', // Brown
                midiChannel: chain.midiChannel
            });
        }
        console.log("Finished setting up chain buttons");
        console.log("Current button texts:", JSON.stringify(Object.fromEntries(this.#buttonTexts), null, 2));
    }

    async loadChain(chain) {
        console.log(`Loading chain: ${chain.name}`);
        console.log(`Chain details: ${JSON.stringify(chain, null, 2)}`);
        this.#currentChain = chain;
        await this.resetDeck();
        await this.createShowChainsButton();
        await this.createChainNameButton(chain.name);
        await this.showModules(chain);
        console.log(`Finished loading chain: ${chain.name}`);
    }

    async showModules(chain) {
        console.log(`Showing modules for chain: ${chain.name}`);
        console.log(`Modules: ${JSON.stringify(chain.modules, null, 2)}`);
        
        const layout = chain.modules.map((module, index) => ({
            label: module.deviceName || 'Unknown Device',
            backgroundColor: this.#getColorForRole(module.role),
            textColor: '#ffffff',
            fontSize: 12,
            module: module
        }));

        await this.createCustomLayout(layout);
    }

    async createShowChainsButton() {
        console.log("Creating 'Show Chains' button");
        await this.setButtonText(0, "Show Chains", {
            fontSize: 16,
            color: '#ffffff',
            backgroundColor: '#FF0000' // Red
        });
    }

    async createChainNameButton(chainName) {
        console.log(`Creating chain name button: ${chainName}`);
        await this.setButtonText(1, chainName, {
            fontSize: 16,
            color: '#ffffff',
            backgroundColor: '#8B4513', // Brown
            midiChannel: this.#currentChain.midiChannel
        });

        this.registerButtonAction(1, 
            () => {
                console.log(`Current Chain button pressed: '${chainName}'`);
                console.dir(this.#currentChain, { depth: null });
            },
            null,
            { type: 'currentChain', name: chainName }
        );
    }


    #getColorForRole(role) {
        switch (role.toLowerCase()) {
            case 'source':
                return '#00008B'; // Dark Blue
            case 'proc':
                return '#FF8C00'; // Dark Orange
            case 'dest':
                return '#006400'; // Dark Green
            default:
                return '#333333'; // Default dark gray for unknown roles
        }
    }

    async createCustomLayout(layout) {
        if (!this.#streamDeck) return;

        console.log(`\nCreating custom layout with ${layout.length} buttons`);

        for (const [index, button] of layout.entries()) {
            if (index >= 30) {
                console.log(`Reached maximum button count (30). Skipping remaining ${layout.length - 30} modules.`);
                break;
            }

            const { label, backgroundColor, textColor, fontSize, module } = button;

            // Offset the index by 2 to account for the new buttons
            const buttonIndex = index + 2;

            console.log(`\nSetting up button ${buttonIndex}:`);
            console.log(`Button details: ${JSON.stringify(button, null, 2)}`);

            await this.setButtonText(buttonIndex, label, {
                fontSize,
                color: textColor,
                backgroundColor
            });

            // Register a more detailed action for each button
            this.registerButtonAction(buttonIndex, 
                () => {
                    console.log(`\nModule button pressed: "${label}"`);
                    console.log(`Module "${module.deviceName || 'Unknown Device'}" activated:`);
                    console.log(JSON.stringify(module, null, 2));
                },
                null,
                { type: 'module', name: label, role: module.role }
            );
        }

        console.log('\nCustom layout creation completed.');
    }

    async setBrightness(brightness) {
        if (!this.#streamDeck) return;
        await this.#streamDeck.setBrightness(brightness);
    }

    disconnect() {
        if (this.#streamDeck) {
            this.#streamDeck.close();
            this.#streamDeck = null;
        }
    }
}

// Example usage
const main = async () => {
    // Check for command line argument
    if (process.argv.length < 3) {
        console.error('Please provide a file path as an argument');
        console.error('Usage: node streamdeck.mjs <filepath>');
        process.exit(1);
    }

    const jsonFilePath = process.argv[2];
    const controller = new StreamDeckController();

    console.log(`Stream Deck Controller v${VERSION}`);

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Load the chain layout from the provided JSON file
    await controller.loadChainLayout(jsonFilePath);

    // Handle cleanup on exit
    process.on('SIGINT', () => {
        console.log('Cleaning up...');
        controller.disconnect();
        process.exit();
    });
};

main().catch(console.error);

export default StreamDeckController;

