import { action, computed, makeObservable, observable } from 'mobx';
/* [AI] - Analytics removed - utility functions moved to @/utils/account-helpers */
import { getAccountId, isDemoAccount } from '@/utils/account-helpers';
/* [/AI] */
import { isEmptyObject } from '@/components/shared';
import { isMultipliersOnly, isOptionsBlocked } from '@/components/shared/common/utility';
import { removeCookies } from '@/components/shared/utils/storage/storage';
import { observer as globalObserver, observer } from '@/external/bot-skeleton';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { API_BASE } from '@/utils/api-base';
import { resolveDisplayCurrency, sanitizeUsdKesRate, TDisplayCurrency } from '@/utils/display-currency';
import { ErrorLogger } from '@/utils/error-logger';
import { clearApiTokenSession } from '@/utils/api-token-permissions';
import type { Balance } from '@deriv/api-types';
import {
    authData$,
    setAccountList,
    setAuthData,
    setIsAuthorized,
} from '../external/bot-skeleton/services/api/observables/connection-status-stream';
import type { TAuthData } from '../types/api-types';
import type RootStore from './root-store';

type TDemoBalanceOverride = {
    baseline_server_balance: number;
    currency: string;
    custom_balance: number;
    last_known_server_balance: number;
};

const DEMO_BALANCE_OVERRIDES_KEY = 'demo_balance_overrides';
const getBalanceDecimalPlaces = (currency?: string) => {
    const normalizedCurrency = (currency || '').toUpperCase();
    return normalizedCurrency === 'BTC' || normalizedCurrency === 'ETH' || normalizedCurrency.includes('USDT') ? 8 : 2;
};

export default class ClientStore {
    loginid = '';
    account_list: TAuthData['account_list'] = [];
    balance = '0';
    currency = 'AUD';
    display_currency: TDisplayCurrency = resolveDisplayCurrency(localStorage.getItem('display_currency'), 'USD');
    usd_kes_rate = sanitizeUsdKesRate(null);
    exchange_rate_updated_at = '';
    is_logged_in = false;
    is_account_regenerating = false;

    accounts: Record<string, TAuthData['account_list'][number]> = {};
    all_accounts_balance: Balance | null = null;
    is_logging_out = false;
    demo_balance_overrides: Record<string, TDemoBalanceOverride> = {};
    server_balances: Record<string, number> = {};

    private authDataSubscription: { unsubscribe: () => void } | null = null;
    private root_store: RootStore;
    private tab_visibility_handler: ((event: Event) => void) | null = null;
    private ws_login_id: string | null = null;
    private is_regenerating = false;
    private instance_id: string = '';
    private exchange_rate_refresh_timer: ReturnType<typeof window.setInterval> | null = null;

    // TODO: fix with self exclusion

    onAuthorizeEvent = (data: {
        account_list?: TAuthData['account_list'];
        current_account?: { loginid: string; currency: string; is_virtual: number; balance?: number };
    }) => {
        if (data?.account_list) {
            this.setAccountList(data.account_list);
        }

        // Update current account details from new API structure
        if (data?.current_account) {
            this.setLoginId(data.current_account.loginid);
            this.setCurrency(data.current_account.currency);
            this.setIsLoggedIn(true);
            localStorage.setItem('active_loginid', data.current_account.loginid);

            // Store the login ID used for WebSocket connection
            this.setWebSocketLoginId(data.current_account.loginid);

            if (typeof data.current_account.balance === 'number') {
                this.applyBalanceUpdate(
                    data.current_account.loginid,
                    data.current_account.currency,
                    data.current_account.balance
                );
            }
        }
    };

    constructor(root_store: RootStore) {
        this.root_store = root_store;
        // Subscribe to auth data changes
        this.authDataSubscription = authData$.subscribe(() => {});

        observer.register('api.authorize', this.onAuthorizeEvent);

        this.demo_balance_overrides = this.hydrateDemoBalanceOverrides();

        // Clean up any existing instance before registering new one to prevent memory leaks
        const existingId = globalObserver.getState('client.store.id');
        if (existingId) {
            globalObserver.setState({ 'client.store': null, 'client.store.id': null });
        }

        // Register this instance with the global observer so api-base can access it
        // Store a reference to this instance with a cryptographically secure unique ID to prevent memory leaks
        // Use crypto.getRandomValues for better uniqueness and security than Math.random()
        this.instance_id = `client_store_${Date.now()}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
        globalObserver.setState({ 'client.store': this, 'client.store.id': this.instance_id });

        // Set up visibility change listener to regenerate WebSocket when tab becomes visible
        this.setupVisibilityListener();

        makeObservable(this, {
            accounts: observable,
            account_list: observable,

            all_accounts_balance: observable,
            balance: observable,
            currency: observable,
            demo_balance_overrides: observable,
            display_currency: observable,
            exchange_rate_updated_at: observable,
            usd_kes_rate: observable,

            is_logged_in: observable,
            is_account_regenerating: observable,
            loginid: observable,
            is_logging_out: observable,
            active_accounts: computed,
            is_bot_allowed: computed,

            is_eu_or_multipliers_only: computed,
            is_low_risk: computed,
            is_multipliers_only: computed,
            is_options_blocked: computed,
            is_virtual: computed,

            residence: computed,

            logout: action,
            onAuthorizeEvent: action,
            setAccountList: action,

            setAllAccountsBalance: action,
            setIsAccountRegenerating: action,
            setBalance: action,
            setCurrency: action,
            setDisplayCurrency: action,
            resetDemoBalance: action,
            setExchangeRateData: action,
            setIsLoggedIn: action,
            setIsLoggingOut: action,
            setLoginId: action,

            is_trading_experience_incomplete: computed,
            is_cr_account: computed,
            account_open_date: computed,
        });

        if (this.display_currency === 'KES') {
            this.startExchangeRateAutoRefresh();
        }
    }

    get active_accounts() {
        return this.accounts instanceof Object
            ? Object.values(this.accounts).filter(account => !account.is_disabled)
            : [];
    }

    get is_bot_allowed() {
        return this.isBotAllowed();
    }
    get is_trading_experience_incomplete() {
        return false;
    }

    get is_low_risk() {
        return false;
    }

    get residence() {
        return '';
    }

    get is_options_blocked() {
        return isOptionsBlocked(this.residence);
    }

    get is_multipliers_only() {
        return isMultipliersOnly(this.residence);
    }

    get is_eu_or_multipliers_only() {
        // Always return false - EU restrictions now handled by backend
        return false;
    }

    get is_virtual() {
        return !isEmptyObject(this.accounts) && this.accounts[this.loginid] && !!this.accounts[this.loginid].is_virtual;
    }

    get all_loginids() {
        return !isEmptyObject(this.accounts) ? Object.keys(this.accounts) : [];
    }

    get virtual_account_loginid() {
        return this.all_loginids.find(loginid => !!this.accounts[loginid].is_virtual);
    }

    get is_cr_account() {
        return this.loginid?.startsWith('CR');
    }

    get should_hide_header() {
        return false;
    }

    get account_open_date() {
        if (isEmptyObject(this.accounts) || !this.accounts[this.loginid]) return undefined;
        return Object.keys(this.accounts[this.loginid]).includes('created_at')
            ? this.accounts[this.loginid].created_at
            : undefined;
    }

    isBotAllowed = () => {
        return this.is_virtual ? this.is_eu_or_multipliers_only : !this.is_options_blocked;
    };

    setLoginId = (loginid: string) => {
        this.loginid = loginid;
    };

    setAccountList = (account_list?: TAuthData['account_list']) => {
        this.accounts = {};
        const adjustedAccountList =
            account_list?.map(account => {
                const incomingBalance = Number(account.balance ?? 0);
                const existingServerBalance = this.server_balances[account.loginid];
                const shouldReuseKnownServerBalance =
                    !!this.demo_balance_overrides[account.loginid] &&
                    typeof existingServerBalance === 'number' &&
                    Number.isFinite(existingServerBalance) &&
                    Math.abs(
                        incomingBalance -
                            this.getDisplayedBalanceAmount(account.loginid, existingServerBalance, account.currency)
                    ) <
                        1 / 10 ** getBalanceDecimalPlaces(account.currency);
                const serverBalance = shouldReuseKnownServerBalance ? existingServerBalance : incomingBalance;
                this.server_balances[account.loginid] = serverBalance;

                return {
                    ...account,
                    balance: this.getDisplayedBalanceAmount(account.loginid, serverBalance, account.currency),
                };
            }) ?? [];

        adjustedAccountList.forEach(account => {
            this.accounts[account.loginid] = account;
        });
        this.account_list = adjustedAccountList;
    };

    setBalance = (balance: string) => {
        this.balance = balance;
    };

    setCurrency = (currency: string) => {
        this.currency = currency;
    };

    setDisplayCurrency = (currency: TDisplayCurrency) => {
        this.display_currency = resolveDisplayCurrency(currency, 'USD');
        localStorage.setItem('display_currency', this.display_currency);

        if (this.display_currency === 'KES') {
            this.startExchangeRateAutoRefresh();
        } else {
            this.stopExchangeRateAutoRefresh();
        }
    };

    setExchangeRateData = (rate: number, updated_at = '') => {
        this.usd_kes_rate = sanitizeUsdKesRate(rate);
        this.exchange_rate_updated_at = updated_at;
    };

    setIsLoggedIn = (is_logged_in: boolean) => {
        this.is_logged_in = is_logged_in;
    };

    getCurrency = () => {
        const clientAccounts = JSON.parse(localStorage.getItem('clientAccounts') ?? '{}');
        return clientAccounts[this.loginid]?.currency ?? '';
    };

    getToken = () => {
        const accountList = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
        return accountList[this.loginid] ?? '';
    };

    setAllAccountsBalance = (all_accounts_balance: Balance | undefined) => {
        this.all_accounts_balance = all_accounts_balance ?? null;
    };
    setIsAccountRegenerating = (is_loading: boolean) => {
        this.is_account_regenerating = is_loading;
    };

    setIsLoggingOut = (is_logging_out: boolean) => {
        this.is_logging_out = is_logging_out;
    };

    getDemoBalanceOverride = (loginid?: string) => {
        if (!loginid) return undefined;
        return this.demo_balance_overrides[loginid];
    };

    getDisplayBalanceAmount = (loginid?: string) => {
        const resolvedLoginId = loginid || this.loginid || getAccountId() || '';
        if (!resolvedLoginId) return 0;

        const isActiveAccount = resolvedLoginId === this.loginid || resolvedLoginId === getAccountId();

        // this.balance is written directly, synchronously, by the authorize/balance
        // flow the moment a real server balance is confirmed for the active account
        // (see api-base.ts authorizeAndSubscribe). this.accounts[loginid].balance
        // is populated indirectly via setAccountList(), which can be fed a stale
        // account list from an out-of-order concurrent authorizeAndSubscribe() call
        // (e.g. one where the "all accounts" balance fetch failed and defaulted to
        // 0). Because 0 is a defined value, `??` doesn't skip it, so a stale 0
        // there would otherwise permanently mask a correct, freshly-synced balance.
        // For the active account, trust this.balance first; only fall back to the
        // accounts map for accounts other than the currently active one.
        const accountBalance = isActiveAccount
            ? (this.balance ?? this.accounts[resolvedLoginId]?.balance ?? this.account_list.find(account => account.loginid === resolvedLoginId)?.balance)
            : (this.accounts[resolvedLoginId]?.balance ?? this.account_list.find(account => account.loginid === resolvedLoginId)?.balance);

        const numericBalance = Number(accountBalance ?? 0);
        return Number.isFinite(numericBalance) ? numericBalance : 0;
    };

    getAccountCurrency = (loginid?: string) => {
        const resolvedLoginId = loginid || this.loginid || getAccountId() || '';
        if (!resolvedLoginId) return this.currency || 'USD';

        return (
            this.accounts[resolvedLoginId]?.currency ||
            this.account_list.find(account => account.loginid === resolvedLoginId)?.currency ||
            (resolvedLoginId === this.loginid || resolvedLoginId === getAccountId() ? this.currency : '') ||
            'USD'
        );
    };

    hasSufficientDemoBalance = (required_amount: number, loginid?: string) => {
        const resolvedLoginId = loginid || this.loginid || getAccountId() || '';
        if (!resolvedLoginId) return true;

        const normalizedRequiredAmount = Number(required_amount);
        if (!Number.isFinite(normalizedRequiredAmount) || normalizedRequiredAmount <= 0) return true;

        return this.getDisplayBalanceAmount(resolvedLoginId) + 1e-9 >= normalizedRequiredAmount;
    };

    resetDemoBalance = (loginid: string, custom_balance: number, currency?: string) => {
        if (!loginid || !isDemoAccount(loginid) || !Number.isFinite(custom_balance) || custom_balance < 0) return false;

        const currentServerBalance =
            this.server_balances[loginid] ??
            Number(this.accounts[loginid]?.balance ?? (loginid === this.loginid || loginid === getAccountId() ? this.balance : 0) ?? 0);

        const normalizedCurrency = currency || this.accounts[loginid]?.currency || this.currency || 'USD';
        const override: TDemoBalanceOverride = {
            baseline_server_balance: currentServerBalance,
            currency: normalizedCurrency,
            custom_balance,
            last_known_server_balance: currentServerBalance,
        };

        this.demo_balance_overrides = {
            ...this.demo_balance_overrides,
            [loginid]: override,
        };
        this.persistDemoBalanceOverrides();
        this.applyBalanceUpdate(loginid, normalizedCurrency, currentServerBalance);
        return true;
    };

    applyBalanceUpdate = (loginid: string, currency: string, server_balance: number) => {
        this.server_balances[loginid] = server_balance;

        const existingOverride = this.demo_balance_overrides[loginid];
        if (existingOverride) {
            this.demo_balance_overrides = {
                ...this.demo_balance_overrides,
                [loginid]: {
                    ...existingOverride,
                    currency: currency || existingOverride.currency,
                    last_known_server_balance: server_balance,
                },
            };
            this.persistDemoBalanceOverrides();
        }

        const displayBalance = this.getDisplayedBalanceAmount(loginid, server_balance, currency);

        if (loginid === this.loginid || loginid === getAccountId()) {
            this.balance = displayBalance.toString();
            if (currency) this.currency = currency;
        }

        if (this.accounts[loginid]) {
            this.accounts[loginid] = {
                ...this.accounts[loginid],
                balance: displayBalance,
                currency: currency || this.accounts[loginid].currency,
            };
        }

        if (this.account_list.length) {
            this.account_list = this.account_list.map(account =>
                account.loginid === loginid
                    ? {
                          ...account,
                          balance: displayBalance,
                          currency: currency || account.currency,
                      }
                    : account
            );
            setAccountList(this.account_list);
        }
    };

    private hydrateDemoBalanceOverrides = (): Record<string, TDemoBalanceOverride> => {
        try {
            const rawOverrides = localStorage.getItem(DEMO_BALANCE_OVERRIDES_KEY);
            if (!rawOverrides) return {};

            const parsed = JSON.parse(rawOverrides) as Record<string, Partial<TDemoBalanceOverride>>;

            return Object.entries(parsed).reduce<Record<string, TDemoBalanceOverride>>((acc, [loginid, override]) => {
                const baseline_server_balance = Number(override.baseline_server_balance ?? 0);
                const custom_balance = Number(override.custom_balance ?? 0);
                const last_known_server_balance = Number(override.last_known_server_balance ?? baseline_server_balance);

                if (
                    !loginid ||
                    !isDemoAccount(loginid) ||
                    !Number.isFinite(baseline_server_balance) ||
                    !Number.isFinite(custom_balance) ||
                    !Number.isFinite(last_known_server_balance)
                ) {
                    return acc;
                }

                acc[loginid] = {
                    baseline_server_balance,
                    currency: override.currency || 'USD',
                    custom_balance,
                    last_known_server_balance,
                };

                return acc;
            }, {});
        } catch (error) {
            ErrorLogger.error('ClientStore', 'Failed to hydrate demo balance overrides', error);
            return {};
        }
    };

    private persistDemoBalanceOverrides = () => {
        try {
            localStorage.setItem(DEMO_BALANCE_OVERRIDES_KEY, JSON.stringify(this.demo_balance_overrides));
        } catch (error) {
            ErrorLogger.error('ClientStore', 'Failed to persist demo balance overrides', error);
        }
    };

    private getDisplayedBalanceAmount = (loginid: string, server_balance: number, currency?: string) => {
        if (!isDemoAccount(loginid)) return server_balance;

        const override = this.demo_balance_overrides[loginid];
        if (!override) return server_balance;

        const computedBalance = override.custom_balance + (server_balance - override.baseline_server_balance);
        const decimalPlaces = getBalanceDecimalPlaces(currency || override.currency);
        return Number(Math.max(0, computedBalance).toFixed(decimalPlaces));
    };

    fetchUsdKesRate = async () => {
        try {
            const response = await fetch(`${API_BASE}/exchange-rates/usd-kes`);
            if (!response.ok) {
                throw new Error(`Exchange rate request failed with ${response.status}`);
            }

            const data = await response.json();
            this.setExchangeRateData(data?.rate, data?.updated_at || '');
        } catch (error) {
            ErrorLogger.log('Failed to fetch USD/KES rate', error, {
                context: 'client-store.fetchUsdKesRate',
            });
        }
    };

    startExchangeRateAutoRefresh = () => {
        this.fetchUsdKesRate();

        if (this.exchange_rate_refresh_timer) {
            window.clearInterval(this.exchange_rate_refresh_timer);
        }

        this.exchange_rate_refresh_timer = window.setInterval(
            () => {
                this.fetchUsdKesRate();
            },
            10 * 60 * 1000
        );
    };

    stopExchangeRateAutoRefresh = () => {
        if (this.exchange_rate_refresh_timer) {
            window.clearInterval(this.exchange_rate_refresh_timer);
            this.exchange_rate_refresh_timer = null;
        }
    };

    /**
     * Request logout via WebSocket (legacy method for backward compatibility)
     * @returns Promise with logout response
     */

    logout = async () => {
        if (localStorage.getItem('active_loginid')) {
            // Clear DerivAPI singleton instance and close WebSocket
            const { clearDerivApiInstance } = await import('@/external/bot-skeleton/services/api/appId');
            clearDerivApiInstance();

            // Clear accounts cache from DerivWSAccountsService
            const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
            DerivWSAccountsService.clearStoredAccounts();
            DerivWSAccountsService.clearCache();

            // Clear OAuth token from sessionStorage
            const { OAuthTokenExchangeService } = await import('@/services/oauth-token-exchange.service');
            OAuthTokenExchangeService.clearAuthInfo();
            clearApiTokenSession();

            // Reset all the states
            this.account_list = [];
            this.accounts = {};
            this.is_logged_in = false;
            this.loginid = '';
            this.balance = '0';
            this.currency = 'USD';
            this.all_accounts_balance = null;
            this.server_balances = {};

            // Clear localStorage
            localStorage.removeItem('active_loginid');
            localStorage.removeItem('accountsList');
            localStorage.removeItem('authToken');
            localStorage.removeItem('clientAccounts');
            localStorage.removeItem('account_type');

            // Clear sessionStorage
            sessionStorage.clear();

            // Clear cookies
            removeCookies('client_information');

            // Reset observables
            setIsAuthorized(false);
            setAccountList([]);
            setAuthData(null);

            this.setIsLoggingOut(false);

            // Disable livechat
            window.LC_API?.close_chat?.();
            window.LiveChatWidget?.call('hide');

            // Shutdown and initialize intercom
            if (window.Intercom) {
                window.Intercom('shutdown');
                window.DerivInterCom.initialize({
                    hideLauncher: true,
                    token: null,
                });
            }
        }
    };

    /**
     * Sets up visibility change listener to regenerate WebSocket when tab becomes visible
     */
    setupVisibilityListener() {
        // Remove existing listener if any
        this.removeVisibilityListener();

        // Create handler function
        this.tab_visibility_handler = async () => {
            if (document.visibilityState === 'visible' && !this.is_regenerating) {
                // Tab became visible - check if WebSocket needs regeneration
                if (this.is_logged_in) {
                    this.checkAndRegenerateWebSocket();
                }
            }
        };

        // Add listener
        document.addEventListener('visibilitychange', this.tab_visibility_handler);
    }

    /**
     * Set the current WebSocket login ID
     * @param login_id The login ID used for the WebSocket connection
     */
    setWebSocketLoginId(login_id: string) {
        this.ws_login_id = login_id;
    }

    /**
     * Check if WebSocket needs to be regenerated based on login ID comparison
     * @returns True if WebSocket needs regeneration, false otherwise
     */
    needsWebSocketRegeneration(): boolean {
        const active_login_id = getAccountId();
        return (
            !this.is_regenerating &&
            !!active_login_id &&
            !!this.ws_login_id &&
            active_login_id !== this.ws_login_id &&
            !api_base.is_running
        );
    }

    /**
     * Check if WebSocket needs regeneration and regenerate if needed
     */
    checkAndRegenerateWebSocket() {
        if (this.needsWebSocketRegeneration()) {
            this.regenerateWebSocket();
        }
    }

    /**
     * Regenerate WebSocket connection with the new login ID
     * This method clears all data and creates a new connection with the current active login ID
     * Protected against race conditions with the is_regenerating flag
     * Includes error handling to prevent users from being stuck in loading state
     */
    async regenerateWebSocket() {
        if (this.is_regenerating) return;

        this.is_regenerating = true;
        this.setIsAccountRegenerating(true);

        try {
            const active_login_id = getAccountId();

            if (active_login_id) {
                const { clearDerivApiInstance } = await import('@/external/bot-skeleton/services/api/appId');
                clearDerivApiInstance();

                const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
                DerivWSAccountsService.clearCache();

                this.account_list = [];

                this.accounts = {};
                this.setIsLoggedIn(false);

                this.balance = '0';
                this.currency = 'USD';

                this.all_accounts_balance = null;
                this.server_balances = {};

                const accountsListRaw = localStorage.getItem('accountsList');
                if (accountsListRaw) {
                    try {
                        const accountsList = JSON.parse(accountsListRaw) as Record<string, string>;
                        const selectedToken = accountsList[active_login_id];
                        if (selectedToken) localStorage.setItem('authToken', selectedToken);
                    } catch (error) {
                        ErrorLogger.error('ClientStore', 'Failed to preserve legacy account token', error);
                    }
                } else {
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('clientAccounts');
                }
                localStorage.removeItem('account_type');
                removeCookies('client_information');

                setIsAuthorized(false);
                setAccountList([]);
                setAuthData(null);

                this.setIsLoggingOut(false);

                window.LC_API?.close_chat?.();
                window.LiveChatWidget?.call('hide');

                try {
                    await api_base.init(true);
                } catch (initError) {
                    ErrorLogger.error('ClientStore', 'WebSocket initialization failed', initError);
                    this.setIsAccountRegenerating(false);
                    throw initError;
                }

                this.setWebSocketLoginId(active_login_id);
            }
        } catch (error) {
            ErrorLogger.error('ClientStore', 'WebSocket regeneration failed', error);
            this.setIsAccountRegenerating(false);
        } finally {
            this.is_regenerating = false;
        }
    }

    /**
     * Removes the visibility change listener
     */
    removeVisibilityListener() {
        if (this.tab_visibility_handler) {
            document.removeEventListener('visibilitychange', this.tab_visibility_handler);
            this.tab_visibility_handler = null;
        }
    }

    destroy() {
        this.authDataSubscription?.unsubscribe();
        observer.unregister('api.authorize', this.onAuthorizeEvent);
        this.removeVisibilityListener();
        this.stopExchangeRateAutoRefresh();

        // Properly clean up the global observer reference
        // Only clear if this instance is the one referenced by checking the instance ID
        const storedId = globalObserver.getState('client.store.id');
        if (storedId === this.instance_id) {
            globalObserver.setState({ 'client.store': null, 'client.store.id': null });
        }
    }
}
