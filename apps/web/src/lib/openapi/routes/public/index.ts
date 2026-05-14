/**
 * Public route barrel. Importing this module triggers side-effect
 * registration of every public API path in the shared OpenAPI registry.
 */

import './credentials';
import './health';
import './sessions';
import './usage';
import './webhooks';
