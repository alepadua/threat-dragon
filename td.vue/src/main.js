// TODO: Revisit whether mutationobserver-shim is still required under Vue 3
// after removing compat
import 'mutationobserver-shim';
import { createApp } from 'vue';

// Safe console wrapper to prevent external runners or extensions from crashing the app
// on objects that cannot be converted to primitive values (e.g., Object.create(null)).
const wrapConsole = (method) => {
    const original = console[method];
    if (typeof original === 'function') {
        console[method] = function (...args) {
            const safeArgs = args.map(arg => {
                try {
                    String(arg);
                    return arg;
                } catch (e) {
                    try {
                        if (arg === null) return 'null';
                        if (arg === undefined) return 'undefined';
                        if (typeof arg === 'symbol') return arg.toString();
                        if (typeof arg === 'object') {
                            if (typeof arg.toString === 'function') {
                                return arg.toString();
                            }
                            return Object.prototype.toString.call(arg);
                        }
                        return '[Unstringifiable Object]';
                    } catch (innerErr) {
                        return '[Unstringifiable Object]';
                    }
                }
            });
            original.apply(this, safeArgs);
        };
    }
};

wrapConsole('log');
wrapConsole('warn');
wrapConsole('error');
wrapConsole('info');

import App from './App.vue';
import i18nFactory from './i18n/index.js';
import router from './router/index.js';
import storeFactory from './store/index.js';

import BootstrapVue from './plugins/bootstrap-vue.js';
import { FontAwesomeIcon } from './plugins/fontawesome-vue.js';
import Toast, { toastOptions, installToastGlobalProperties } from './plugins/toastification.js';

const app = createApp(App);
app.use(storeFactory.get());
app.use(router.get());
app.use(i18nFactory.get());
app.use(BootstrapVue);
app.use(Toast, toastOptions);
installToastGlobalProperties(app, toastOptions);
app.component('font-awesome-icon', FontAwesomeIcon);
app.mount('#app');
