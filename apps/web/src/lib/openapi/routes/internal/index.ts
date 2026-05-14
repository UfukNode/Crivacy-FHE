/**
 * Internal route barrel. Importing this module triggers side-effect
 * registration of every dashboard-only API path in the shared OpenAPI
 * registry.
 */

import './api-keys';
import './audit-log';
import './auth';
import './firm';
import './playground';
import './usage';
import './webhooks';
