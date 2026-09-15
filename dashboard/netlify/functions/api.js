import serverless from 'serverless-http';
import cloudApp from '../../../cloud/app.js';

export const handler = serverless(cloudApp);