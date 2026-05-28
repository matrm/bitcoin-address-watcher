import FetchRateLimited from 'fetch-rate-limited';
import { StorageNamespaced } from 'storage-namespaced';

// --- AddressInfo ---

type AddressInfo = {
	address: string;
	label: string;
	note: string;
	balanceLastUpdate: number | null;
	balance: number | null;
	spent: boolean | null;
};

function createAddressInfo(address: string): AddressInfo {
	return { address, label: '', note: '', balanceLastUpdate: null, balance: null, spent: null };
}

const storage = new StorageNamespaced<{
	addressInfos: AddressInfo[];
	price: number | null;
}>({
	namespace: 'matrm-bitcoin-address-watcher',
	storage: localStorage,
	autoSave: true,
	resetInvalidStorage: true,
});

let addressInfosUpdated = getAddressInfos().length === 0;
let priceUpdated = false;

const whatsonchainFetch = new FetchRateLimited({ windowMs: 1050, limit: 3 });
const poloniexFetch = new FetchRateLimited({ windowMs: 1050, limit: 3 });
const mattercloudFetch = new FetchRateLimited({ windowMs: 500, limit: 1 });

let confirmDeletingAddressAfterTime = Date.now();

function getAddressInfoBalanceChange(addressInfo: AddressInfo): number {
	return addressInfo.balanceLastUpdate == null || addressInfo.balance == null ? 0 : addressInfo.balance - addressInfo.balanceLastUpdate;
}

// --- Storage ---

function normalizeAddressInfo(data: unknown): AddressInfo | null {
	if (typeof data !== 'object' || data === null) {
		console.log('Rejected address info: not an object', data);
		return null;
	}
	const d = data as Record<string, unknown>;
	if (typeof d.address !== 'string') {
		console.log('Rejected address info: address is not a string', d);
		return null;
	}
	return {
		address: d.address,
		label: typeof d.label === 'string' ? d.label : '',
		note: typeof d.note === 'string' ? d.note : '',
		balanceLastUpdate: typeof d.balanceLastUpdate === 'number' ? d.balanceLastUpdate : null,
		balance: typeof d.balance === 'number' ? d.balance : null,
		spent: typeof d.spent === 'boolean' ? d.spent : null,
	};
}

function getAddressInfos(): AddressInfo[] {
	const raw = storage.getItem('addressInfos');
	if (raw === null) return [];
	if (!Array.isArray(raw)) return [];
	const result: AddressInfo[] = [];
	for (const item of raw) {
		const normalized = normalizeAddressInfo(item);
		if (normalized) {
			result.push(normalized);
		}
	}
	return result;
}

function setAddressInfos(addressInfos: AddressInfo[]): void {
	storage.setItem('addressInfos', addressInfos);
}

function getPrice(): number | null {
	return storage.getItem('price') ?? null;
}

function setPrice(price: number): void {
	storage.setItem('price', price);
	priceUpdated = true;
}

// --- Utilities ---

function assert(condition: unknown, message?: string): asserts condition {
	if (!condition) {
		const errorMessage = message ? `Assertion failed: ${message}` : `Assertion failed: ${String(condition)}`;
		console.error(errorMessage);
		alert('Error: Assertion failure. Do not continue.');
		throw new Error(errorMessage);
	}
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
	const results: T[][] = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		results.push(array.slice(i, i + chunkSize));
	}
	return results;
}

function removeElementChildren(element: HTMLElement): HTMLElement {
	while (element.firstChild) {
		element.removeChild(element.firstChild);
	}
	return element;
}

// --- Export / Import ---

function toExportString(): string {
	const addressInfos = getAddressInfos();
	const price = getPrice();
	return JSON.stringify({
		addressInfos,
		price,
	}, null, '\t');
}

function backupToFile(): void {
	const suggestedFileName = 'bitcoin-address-watcher-backup-' + Math.floor(Date.now() / 1000).toString() + '.json';
	const localStorageString = toExportString();
	const element = document.createElement('a');
	element.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(localStorageString);
	element.download = suggestedFileName;
	element.style.display = 'none';
	document.body.appendChild(element);
	element.click();
	document.body.removeChild(element);
}

function loadFromString(jsonString: string): void {
	const data = JSON.parse(jsonString);

	if (Array.isArray(data.addressInfos)) {
		storage.setItem('addressInfos', data.addressInfos);
	}
	if (typeof data.price === 'number') {
		storage.setItem('price', data.price);
		priceUpdated = false;
	}
	addressInfosUpdated = getAddressInfos().length === 0;
}

// --- Price Fetching ---

async function fetchPriceFromWhatsonchain(): Promise<number> {
	const url = 'https://api.whatsonchain.com/v1/bsv/main/exchangerate';

	const response = await whatsonchainFetch.fetch(url);

	if (!response.ok) {
		throw new Error(`Request for price rejected with status ${response.status}`);
	}

	const responseJSON: { currency: string; rate: string } = await response.json();

	if (responseJSON.currency !== 'USD') {
		throw new Error(`Unexpected price currency: "${responseJSON.currency}"`);
	}

	const price = parseFloat(responseJSON.rate) / 100000000;

	if (!Number.isFinite(price)) {
		throw new Error(`Price of "${responseJSON.rate}" is invalid`);
	}

	return price;
}

async function fetchPriceFromPoloniex(): Promise<number> {
	const url = 'https://poloniex.com/public?command=returnTicker';

	const response = await poloniexFetch.fetch(url);

	if (!response.ok) {
		throw new Error(`Request for price rejected with status ${response.status}`);
	}

	const responseJSON: { USDC_BCHSV: { last: string } } = await response.json();

	const price = parseFloat(responseJSON.USDC_BCHSV.last) / 100000000;

	if (!Number.isFinite(price)) {
		throw new Error(`Price of "${responseJSON.USDC_BCHSV.last}" is invalid`);
	}

	return price;
}

async function fetchPrice(): Promise<number> {
	const errorMessages: string[] = [];

	try {
		return await fetchPriceFromWhatsonchain();
	} catch (err) {
		console.log(err);
		errorMessages.push(`Error updating price from Whatsonchain: ${(err as Error).message}`);
	}

	try {
		return await fetchPriceFromPoloniex();
	} catch (err) {
		console.log(err);
		errorMessages.push(`Error updating price from Poloniex: ${(err as Error).message}`);
	}

	throw new Error(`Error updating price from all sources:\n${errorMessages.join(',\n')}.`);
}

// --- Address Info Fetching ---

async function updateAddressInfosFromWhatsonchain(addressInfos: AddressInfo[]): Promise<void> {
	type WhatsonchainBalanceEntry = {
		address: string;
		confirmed: number;
		error?: string;
	};
	assert(addressInfos.length > 0);

	const addresses = addressInfos.map(addressInfo => addressInfo.address);
	const addressesSet = new Set(addresses);

	const chunksOfAddresses = chunkArray(addresses, 20);

	const url = 'https://api.whatsonchain.com/v1/bsv/main/addresses/confirmed/balance';

	const responseJSONs: WhatsonchainBalanceEntry[] = [];

	for (const chunkOfAddresses of chunksOfAddresses) {
		const response = await whatsonchainFetch.fetch(url, {
			method: 'POST',
			cache: 'no-cache',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				addresses: chunkOfAddresses
			}),
		});

		if (!response.ok) {
			throw new Error(`Request for address info rejected with status ${response.status}`);
		}

		const responseJSON: unknown = await response.json();

		if (!Array.isArray(responseJSON)) {
			console.error(`Error: Expected an array but received ${typeof responseJSON}.`);
			throw new Error('Invalid data type received');
		}

		const entries = responseJSON as WhatsonchainBalanceEntry[];
		responseJSONs.push(...entries);
	}

	const addressKey_BalanceValue: Record<string, number> = {};

	responseJSONs.forEach(balanceObject => {
		const errorString: string = balanceObject.error || '';

		if (errorString.length) {
			throw new Error(`Error with address "${balanceObject.address}": "${errorString}"`);
		}

		const balance: number = balanceObject.confirmed;

		if (!Number.isSafeInteger(balance) || balance < 0) {
			throw new Error(`Invalid balance for address "${balanceObject.address}" of ${balance}`);
		}

		addressKey_BalanceValue[balanceObject.address] = balance;
	});

	if (Object.keys(addressKey_BalanceValue).length !== addressesSet.size) {
		throw new Error(`Received data for ${Object.keys(addressKey_BalanceValue).length} out of ${addressesSet.size} expected addresses`);
	}

	addressInfos.forEach(addressInfo => {
		const balance = addressKey_BalanceValue[addressInfo.address];
		addressInfo.balanceLastUpdate = addressInfo.balance;
		addressInfo.balance = balance;
	});
}

async function updateAddressInfosFromMatterCloud(addressInfos: AddressInfo[]): Promise<void> {
	type MatterCloudBalanceEntry = {
		address: string;
		confirmed: number;
		unconfirmed: number;
	};
	assert(addressInfos.length > 0);

	const addresses = addressInfos.map(addressInfo => addressInfo.address);

	const url = 'https://api.mattercloud.net/api/v3/main/address/balance';

	const response = await mattercloudFetch.fetch(url, {
		method: 'POST',
		cache: 'no-cache',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			addrs: addresses.join(',')
		})
	});

	if (!response.ok) {
		throw new Error(`Request for address info rejected with status ${response.status}`);
	}

	const responseJSON: unknown = await response.json();

	if (!Array.isArray(responseJSON)) {
		console.error(`Error: Expected an array but received ${typeof responseJSON}.`);
		throw new Error('Invalid data type received');
	}

	const entries = responseJSON as MatterCloudBalanceEntry[];

	if (entries.length !== addressInfos.length) {
		throw new Error(`Received data for ${entries.length} out of ${addressInfos.length} expected addresses`);
	}

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const address: string = entry.address;
		const confirmed: number = entry.confirmed;
		const unconfirmed: number = entry.unconfirmed;
		if (address !== addressInfos[i].address) {
			throw new Error(`Invalid or out of order address "${address}" received`);
		}
		if (typeof confirmed !== 'number' || typeof unconfirmed !== 'number') {
			const errorMessage = 'Unexpected balance data received';
			console.log(errorMessage);
			console.log('address:', address);
			console.log('confirmed:', confirmed);
			console.log('unconfirmed:', unconfirmed);
			throw new Error(errorMessage);
		}
		addressInfos[i].balanceLastUpdate = addressInfos[i].balance;
		addressInfos[i].balance = confirmed + unconfirmed;
	}
}

async function updateAddressInfos(addressInfos: AddressInfo[]): Promise<void> {
	if (!addressInfos.length) {
		return;
	}

	const errorMessages: string[] = [];

	try {
		await updateAddressInfosFromWhatsonchain(addressInfos);
		return;
	} catch (err) {
		console.log(err);
		errorMessages.push(`Error updating address info from Whatsonchain: ${(err as Error).message}`);
	}

	try {
		await updateAddressInfosFromMatterCloud(addressInfos);
		return;
	} catch (err) {
		console.log(err);
		errorMessages.push(`Error updating address info from MatterCloud: ${(err as Error).message}`);
	}

	throw new Error(`Error updating address info from all sources:\n${errorMessages.join(',\n')}.`);
}

// --- Combined Update ---

async function updateAddressInfosAndPrice(addressInfos: AddressInfo[]): Promise<void> {
	const pricePromise = fetchPrice()
		.then(price => {
			setPrice(price);
		})
		.catch((error: Error) => {
			priceUpdated = false;
			console.log(error.message);
			if (getPrice()) {
				alert(error.message);
			}
		});

	try {
		await updateAddressInfos(addressInfos);
		setAddressInfos(addressInfos);
		addressInfosUpdated = true;
	} catch (err) {
		addressInfosUpdated = getAddressInfos().length === 0;
		console.log((err as Error).message);
		alert((err as Error).message);
	}

	await pricePromise;
}

// --- Rendering ---

function render(): void {
	const addressInfos = getAddressInfos();
	const price = getPrice();

	const totalBalance = addressInfos.reduce((t, address) => t + (address.balance || 0), 0);
	const totalBalanceChange = addressInfos.reduce((t, address) => t + getAddressInfoBalanceChange(address), 0);
	const totalValuation = addressInfos.reduce((t, address) => t + (address.balance && price ? address.balance * price : 0), 0);
	const totalBalanceDisplayString = totalBalance.toLocaleString();
	const totalValuationDisplayString = totalValuation.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

	const headersContainer = document.getElementById('headersContainer')!;
	removeElementChildren(headersContainer);

	const addressesTableContainer = document.getElementById('addressesTableContainer')!;
	removeElementChildren(addressesTableContainer);

	const removeAddressesButtonsContainer = document.getElementById('removeAddressesButtonsContainer')!;
	removeElementChildren(removeAddressesButtonsContainer);

	const totalBalanceHeader = document.createElement('h1');
	if (!addressInfosUpdated) {
		totalBalanceHeader.classList.add('transparent');
	}
	totalBalanceHeader.id = 'totalBalanceHeader';
	totalBalanceHeader.appendChild(document.createTextNode(`Balance: ${totalBalanceDisplayString}`));
	headersContainer.appendChild(totalBalanceHeader);

	if (addressInfos.length === 0) {
		return;
	}

	if (price) {
		const totalValuationHeader = document.createElement('h1');
		if (!priceUpdated) {
			totalValuationHeader.classList.add('transparent');
		}
		totalValuationHeader.id = 'totalValuationHeader';
		totalValuationHeader.appendChild(document.createTextNode(`${totalValuationDisplayString} USD`));
		headersContainer.appendChild(totalValuationHeader);
	}

	const addressesTable = document.createElement('table');
	addressesTable.classList.add('standardMargin');

	// Header row.
	addressesTable.appendChild((() => {
		const tr = document.createElement('tr');
		tr.appendChild(document.createElement('th'));
		tr.appendChild((() => {
			const th = document.createElement('th');
			th.appendChild(document.createTextNode('Label'));
			return th;
		})());
		tr.appendChild((() => {
			const th = document.createElement('th');
			th.appendChild(document.createTextNode('Address'));
			return th;
		})());
		tr.appendChild((() => {
			const th = document.createElement('th');
			th.appendChild(document.createTextNode('Balance'));
			return th;
		})());
		if (price) {
			tr.appendChild((() => {
				const th = document.createElement('th');
				th.appendChild(document.createTextNode('USD'));
				return th;
			})());
		}
		tr.appendChild(document.createElement('th'));
		return tr;
	})());

	for (let i = 0; i < addressInfos.length; i++) {
		const addressInfo = addressInfos[i];
		const balanceLastUpdate = addressInfo.balanceLastUpdate;
		const balance = addressInfo.balance;
		const balanceChange = getAddressInfoBalanceChange(addressInfo);
		const spent = addressInfo.spent;
		const valuation = balance == null || price == null ? null : balance * price;
		const balanceDisplayString = balance == null ? '' : balance.toLocaleString();
		const valuationDisplayString = valuation == null ? '' : valuation.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

		if (balanceChange !== 0) {
			console.log(`Balance change for address ${i + 1}: ${balanceChange} (from ${balanceLastUpdate} to ${balance}).`);
		}

		addressesTable.appendChild((() => {
			const tr = document.createElement('tr');
			tr.appendChild((() => {
				const td = document.createElement('td');
				td.classList.add('tdWithInput');
				td.appendChild((() => {
					const button = document.createElement('input');
					button.classList.add('input');
					button.classList.add('inputButton');
					button.classList.add('deleteAddressButton');
					button.type = 'button';
					button.title = `Remove address ${i + 1}`;
					button.value = 'X';
					button.onclick = () => { removeAddressInfosIndex(i); };
					return button;
				})());
				return td;
			})());
			tr.appendChild((() => {
				const td = document.createElement('td');
				td.classList.add('tdWithInput');
				td.appendChild((() => {
					const input = document.createElement('input');
					input.classList.add('input');
					input.type = 'text';
					input.value = addressInfo.label;
					input.onchange = () => updateAddressInfosLabelFromIndex(i, input.value);
					return input;
				})());
				return td;
			})());
			tr.appendChild((() => {
				const td = document.createElement('td');
				td.classList.add('textLeft');
				if (addressInfo.note) {
					td.title = addressInfo.note;
				}
				td.appendChild(document.createTextNode(addressInfo.address));
				return td;
			})());
			tr.appendChild((() => {
				const td = document.createElement('td');
				td.classList.add('textRight');
				if (!addressInfosUpdated) {
					td.classList.add('transparent');
				}
				if (balanceChange) {
					td.classList.add(balanceChange > 0 ? 'increaseColor' : 'decreaseColor');
					td.title = balanceChange > 0 ? `+${balanceChange.toLocaleString()}` : `-${Math.abs(balanceChange).toLocaleString()}`;
				}
				if (spent) {
					if (!balanceChange) {
						td.classList.add('spentColor');
					}
					if (td.title) {
						td.title += '\n';
					}
					if (balance) {
						td.title += 'Warning: This address has a balance after transactions sent to this address have been spent.';
					} else {
						td.title += 'Transactions sent to this address have been spent.';
					}
				}
				td.appendChild(document.createTextNode(balanceDisplayString));
				return td;
			})());
			if (price) {
				tr.appendChild((() => {
					const td = document.createElement('td');
					td.classList.add('textRight');
					if (!priceUpdated) {
						td.classList.add('transparent');
					}
					td.appendChild(document.createTextNode(valuationDisplayString));
					return td;
				})());
			}
			tr.appendChild((() => {
				const td = document.createElement('td');
				td.classList.add('tdImageButton');
				td.appendChild((() => {
					const a = document.createElement('a');
					a.href = `https://www.whatsonchain.com/address/${encodeURIComponent(addressInfo.address)}`;
					a.target = '_blank';
					a.title = 'View on block explorer';
					a.appendChild((() => {
						const img = document.createElement('img');
						img.src = 'https://www.whatsonchain.com/assets/images/logo/favicon-woc.ico';
						img.alt = 'View';
						return img;
					})());
					return a;
				})());
				return td;
			})());
			return tr;
		})());
	}

	if (addressInfos.length > 1) {
		if (totalBalanceChange !== 0) {
			console.log(`Total balance change: ${totalBalanceChange}.`);
		}

		// Last row.
		addressesTable.appendChild((() => {
			const tr = document.createElement('tr');
			tr.appendChild(document.createElement('th'));
			tr.appendChild(document.createElement('th'));
			tr.appendChild((() => {
				const th = document.createElement('th');
				th.classList.add('textRight');
				th.appendChild(document.createTextNode('Total:'));
				return th;
			})());
			tr.appendChild((() => {
				const td = document.createElement('td');
				td.classList.add('textRight');
				if (!addressInfosUpdated) {
					td.classList.add('transparent');
				}
				if (totalBalanceChange !== 0) {
					td.classList.add(totalBalanceChange > 0 ? 'increaseColor' : 'decreaseColor');
					td.title = totalBalanceChange > 0 ? `+${totalBalanceChange.toLocaleString()}` : `-${Math.abs(totalBalanceChange).toLocaleString()}`;
				}
				td.appendChild(document.createTextNode(totalBalanceDisplayString));
				return td;
			})());
			if (price) {
				tr.appendChild((() => {
					const td = document.createElement('td');
					td.classList.add('textRight');
					if (!priceUpdated) {
						td.classList.add('transparent');
					}
					td.appendChild(document.createTextNode(totalValuationDisplayString));
					return td;
				})());
			}
			tr.appendChild(document.createElement('th'));
			return tr;
		})());

		// Remove multiple address buttons.
		const createRemoveAddressesButton = (onclick: () => void, value: string, title?: string): HTMLInputElement => {
			const button = document.createElement('input');
			button.type = 'button';
			button.classList.add('input');
			button.classList.add('inputButton');
			button.classList.add('standardMargin');
			button.onclick = onclick;
			button.value = value;
			if (title) {
				button.title = title;
			}
			return button;
		};
		removeAddressesButtonsContainer.appendChild(createRemoveAddressesButton(removeAddressInfosContainingPromptLabel, 'Remove Labels Containing'));
		removeAddressesButtonsContainer.appendChild(createRemoveAddressesButton(removeAddressInfosMatchingPromptLabel, 'Remove Labels Matching'));
		removeAddressesButtonsContainer.appendChild(createRemoveAddressesButton(removeAddressInfosBalanceOfZero, 'Remove Valueless'));
		removeAddressesButtonsContainer.appendChild(createRemoveAddressesButton(removeAddressInfos, 'Remove All'));
	}

	addressesTableContainer.appendChild(addressesTable);
}

// --- Address CRUD ---

function removeAddressInfosBalanceOfZero(): void {
	if (!confirm('Remove addresses with a balance of 0?')) {
		return;
	}
	setAddressInfos(getAddressInfos().filter(address => address.balance));
	render();
}

function removeAddressInfosMatchingPromptLabel(): void {
	const input = prompt('Remove addresses with label matching text (or leave blank to remove all unlabeled addresses):');
	if (input == null) {
		return;
	}
	setAddressInfos(getAddressInfos().filter(address => address.label !== input));
	render();
}

function removeAddressInfosContainingPromptLabel(): void {
	const input = prompt('Remove addresses with label containing text:');
	if (!input) {
		return;
	}
	setAddressInfos(getAddressInfos().filter(address => !address.label.includes(input)));
	render();
}

function removeAddressInfos(): void {
	if (!confirm('Remove all addresses?')) {
		return;
	}
	setAddressInfos([]);
	render();
}

function removeAddressInfosIndex(index: number): void {
	if (
		Date.now() > confirmDeletingAddressAfterTime &&
		!confirm(`Remove address ${index + 1}?`)
	) {
		return;
	}
	const addressInfos = getAddressInfos();
	addressInfos.splice(index, 1);
	setAddressInfos(addressInfos);
	render();
	confirmDeletingAddressAfterTime = Date.now() + 3000;
}

function updateAddressInfosLabelFromIndex(index: number, label: string): void {
	const addressInfos = getAddressInfos();
	addressInfos[index].label = label;
	setAddressInfos(addressInfos);
}

// --- Update + Render orchestration ---

async function updateRender(addressInfos: AddressInfo[], scrollOnSuccess = false): Promise<void> {
	await updateAddressInfosAndPrice(addressInfos);
	if (addressInfosUpdated || priceUpdated) {
		render();
		if (scrollOnSuccess && addressInfosUpdated) {
			window.scrollTo(0, document.body.scrollHeight);
		}
	}
}

function renderUpdateRender(): void {
	const addressInfos = getAddressInfos();

	const defaultBalanceLastUpdate: number | null = null;
	for (const addressInfo of addressInfos) {
		addressInfo.balanceLastUpdate = defaultBalanceLastUpdate;
	}

	render();

	if (addressInfos.length) {
		updateRender(addressInfos);
	}
}

function loadFromFileAndRender(inputTarget: HTMLInputElement): void {
	const reader = new FileReader();
	reader.onload = () => {
		try {
			loadFromString(reader.result as string);
			console.log('Loaded from file.');
			renderUpdateRender();
		} catch (err) {
			const errorMessage = `Unable to parse JSON backup file: ${(err as Error).message}`;
			console.log(errorMessage);
			alert(errorMessage);
		}
	};
	reader.onerror = () => {
		reader.abort();
		const errorMessage = 'Error reading file.';
		console.log(errorMessage);
		alert(errorMessage);
	};
	if (inputTarget.files?.[0]) {
		reader.readAsText(inputTarget.files[0]);
	}
	inputTarget.value = '';
}

function addInputAddresses(): void {
	const inputAddresses = document.getElementById('inputAddresses') as HTMLInputElement;
	const addresses = inputAddresses.value
		.split(',')
		.map(a => a.replace(/[^A-Z0-9]+/ig, ''))
		.filter(a => a.length !== 0);

	if (addresses.length === 0) {
		alert('No valid addresses to add.');
		return;
	}

	inputAddresses.value = '';

	const addressInfos = getAddressInfos().concat(addresses.map(a => createAddressInfo(a)));

	updateRender(addressInfos, /* scrollOnSuccess */ true);
}

// --- Initialization ---

document.getElementById('addAddressesButton')!.onclick = addInputAddresses;
document.getElementById('exportButton')!.onclick = backupToFile;
const importFileInput = document.getElementById('importFileInput')!;
importFileInput.onchange = () => {
	loadFromFileAndRender(importFileInput as HTMLInputElement);
};

renderUpdateRender();
