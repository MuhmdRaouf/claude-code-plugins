/**
 * Stylesheets are build-time assets: the side-effect import of app.css is extracted by vite into
 * plugin/public/app.css; the bundle itself never reads it, so an empty declaration is all it needs.
 */

declare module "*.css";
