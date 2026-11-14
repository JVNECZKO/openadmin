// User-level routes are composed from feature modules.
import * as dashboard from '../features/dashboard.mjs';
import * as domains from '../features/domains.mjs';
import * as email from '../features/email.mjs';
import * as files from '../features/files.mjs';
import * as databases from '../features/databases.mjs';
import * as security from '../features/security.mjs';
import * as account from '../features/account.mjs';
import * as advanced from '../features/advanced.mjs';
import * as twofa from '../features/twofa.mjs';
import * as hostedApps from '../features/hosted-apps.mjs';
import * as wizards from '../features/wizards.mjs';
import * as help from '../features/help.mjs';
import { register as registerNotifications } from '../features/notifications.mjs';
import { register as registerWebdisk } from '../features/webdisk.mjs';
import { register as registerAppCatalog } from '../features/app-catalog.mjs';

const features = [dashboard, domains, email, files, databases, security, account, advanced, twofa, hostedApps, wizards, help, { register: registerNotifications }, { register: registerWebdisk }, { register: registerAppCatalog }];

export function registerUserRoutes(router) {
  for (const f of features) f.register(router);
}
