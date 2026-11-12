export const isResolvedPptxWorkerLocation = (moduleUrl, assetUrl) => {
    const relativePath = ['worker', 'pptx.worker.js'].join('/');
    const dependencyRelativeUrl = new URL(relativePath, moduleUrl);
    return assetUrl.href !== dependencyRelativeUrl.href || /\/dist\/worker\.[cm]?js$/.test(moduleUrl.pathname);
};
