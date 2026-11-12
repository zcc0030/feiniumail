const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
export class PptxPresentation {
    constructor(viewer, labels = {}, fullscreen = true) {
        this.overlay = null;
        this.stage = null;
        this.counter = null;
        this.placeholder = null;
        this.listeners = [];
        this.layoutFrame = 0;
        this.ownsFullscreen = false;
        this.current = 1;
        this.viewer = viewer;
        this.labels = labels;
        this.fullscreen = fullscreen;
    }
    get active() {
        return Boolean(this.overlay);
    }
    get slideNumber() {
        return this.current;
    }
    get state() {
        return { active: this.active, slideNumber: this.current, total: this.viewer.slideCount };
    }
    async enter(slideNumber = this.current) {
        var _a, _b;
        if (this.active || this.viewer.slideCount === 0) {
            return;
        }
        const documentRef = this.viewer.target.ownerDocument || document;
        const overlay = documentRef.createElement('div');
        overlay.className = 'flyfish-pptx-presentation';
        overlay.tabIndex = -1;
        overlay.setAttribute('role', 'region');
        overlay.setAttribute('aria-label', this.labels.hint || 'Slideshow');
        const stage = documentRef.createElement('div');
        stage.className = 'flyfish-pptx-presentation-stage';
        const counter = documentRef.createElement('div');
        counter.className = 'flyfish-pptx-presentation-counter';
        const hint = documentRef.createElement('div');
        hint.className = 'flyfish-pptx-presentation-hint';
        hint.textContent = this.labels.hint || '';
        hint.hidden = !this.labels.hint;
        const exit = documentRef.createElement('button');
        exit.type = 'button';
        exit.className = 'flyfish-pptx-presentation-exit';
        exit.textContent = '✕';
        exit.setAttribute('aria-label', this.labels.exit || 'Exit slideshow');
        exit.addEventListener('click', event => {
            event.stopPropagation();
            this.exit();
        });
        overlay.append(stage, counter, hint, exit);
        this.overlay = overlay;
        this.stage = stage;
        this.counter = counter;
        const styleRoot = this.viewer.presentationRoot;
        styleRoot.appendChild(overlay);
        this.placeholder = documentRef.createComment('flyfish-pptx-presentation');
        this.viewer.saveScrollPosition();
        this.viewer.scaleBox.replaceWith(this.placeholder);
        stage.appendChild(this.viewer.scaleBox);
        this.viewer.content.classList.add('is-presenting');
        this.attach(documentRef, overlay);
        this.goTo(slideNumber);
        if (this.fullscreen) {
            try {
                await ((_a = overlay.requestFullscreen) === null || _a === void 0 ? void 0 : _a.call(overlay));
                this.ownsFullscreen = this.isFullscreenElement(overlay);
            }
            catch {
                this.ownsFullscreen = false;
            }
        }
        if (this.overlay !== overlay) {
            if (this.ownsFullscreen) {
                void ((_b = documentRef.exitFullscreen) === null || _b === void 0 ? void 0 : _b.call(documentRef).catch(() => undefined));
            }
            this.ownsFullscreen = false;
            return;
        }
        overlay.focus({ preventScroll: true });
        this.scheduleLayout();
        this.notify();
    }
    exit() {
        var _a, _b;
        const overlay = this.overlay;
        if (!overlay) {
            return;
        }
        const documentRef = this.viewer.target.ownerDocument || document;
        const shouldExitFullscreen = this.ownsFullscreen && this.isFullscreenElement(overlay);
        this.detach();
        if (this.layoutFrame) {
            (documentRef.defaultView || window).cancelAnimationFrame(this.layoutFrame);
            this.layoutFrame = 0;
        }
        this.viewer.content.classList.remove('is-presenting');
        for (const container of this.slideContainers()) {
            container.classList.remove('is-active-slide');
        }
        if ((_a = this.placeholder) === null || _a === void 0 ? void 0 : _a.parentNode) {
            this.placeholder.replaceWith(this.viewer.scaleBox);
        }
        else {
            this.viewer.target.appendChild(this.viewer.scaleBox);
        }
        this.placeholder = null;
        overlay.remove();
        this.overlay = null;
        this.stage = null;
        this.counter = null;
        if (shouldExitFullscreen) {
            void ((_b = documentRef.exitFullscreen) === null || _b === void 0 ? void 0 : _b.call(documentRef).catch(() => undefined));
        }
        this.ownsFullscreen = false;
        this.viewer.restoreScrollPosition();
        this.notify();
    }
    async toggle(slideNumber) {
        if (this.active) {
            this.exit();
            return;
        }
        await this.enter(slideNumber);
    }
    goTo(slideNumber) {
        const total = this.viewer.slideCount;
        if (total === 0) {
            return;
        }
        this.current = clamp(Math.round(slideNumber) || 1, 1, total);
        this.viewer.ensureSlideRendered(this.current);
        this.viewer.ensureSlideRendered(this.current + 1);
        const containers = this.slideContainers();
        const byNumber = containers.some(container => Boolean(container.dataset.slideNumber));
        containers.forEach((container, index) => {
            const isActive = byNumber
                ? Number(container.dataset.slideNumber) === this.current
                : index === this.current - 1;
            container.classList.toggle('is-active-slide', isActive);
        });
        if (this.counter) {
            this.counter.textContent = `${this.current} / ${total}`;
        }
        if (this.active) {
            this.scheduleLayout();
            this.notify();
        }
    }
    next() {
        if (this.current < this.viewer.slideCount) {
            this.goTo(this.current + 1);
        }
    }
    previous() {
        if (this.current > 1) {
            this.goTo(this.current - 1);
        }
    }
    layout() {
        const overlay = this.overlay;
        if (!overlay) {
            return;
        }
        const container = this.slideContainers().find((item, index) => {
            if (item.dataset.slideNumber) {
                return Number(item.dataset.slideNumber) === this.current;
            }
            return index === this.current - 1;
        });
        const slide = container && container.classList.contains('flyfish-pptx-slide-slot')
            ? container.firstElementChild
            : container;
        const size = this.viewer.slideDimensions;
        const slideWidth = (slide === null || slide === void 0 ? void 0 : slide.offsetWidth) || (size === null || size === void 0 ? void 0 : size.width) || 0;
        const slideHeight = (slide === null || slide === void 0 ? void 0 : slide.offsetHeight) || (size === null || size === void 0 ? void 0 : size.height) || 0;
        if (!slideWidth || !slideHeight) {
            return;
        }
        const viewWidth = overlay.clientWidth;
        const viewHeight = overlay.clientHeight;
        const scale = Math.min(viewWidth / slideWidth, viewHeight / slideHeight);
        const offsetX = Math.max(0, (viewWidth - slideWidth * scale) / 2);
        const offsetY = Math.max(0, (viewHeight - slideHeight * scale) / 2);
        const content = this.viewer.content;
        content.style.width = `${slideWidth}px`;
        content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
        const scaleBox = this.viewer.scaleBox;
        scaleBox.style.width = '100%';
        scaleBox.style.height = '100%';
        scaleBox.style.minHeight = '';
    }
    destroy() {
        this.exit();
    }
    slots() {
        return Array.from(this.viewer.content.querySelectorAll(':scope > .flyfish-pptx-slide-slot'));
    }
    slideContainers() {
        const slots = this.slots();
        if (slots.length > 0) {
            return slots;
        }
        return Array.from(this.viewer.content.querySelectorAll(':scope > .slide'));
    }
    isFullscreenElement(overlay) {
        const documentRef = this.viewer.target.ownerDocument || document;
        if (documentRef.fullscreenElement === overlay) {
            return true;
        }
        const root = overlay.getRootNode();
        if (root !== documentRef && 'fullscreenElement' in root) {
            return root.fullscreenElement === overlay;
        }
        return false;
    }
    scheduleLayout() {
        const view = this.viewer.target.ownerDocument.defaultView || window;
        if (this.layoutFrame) {
            view.cancelAnimationFrame(this.layoutFrame);
        }
        this.layoutFrame = view.requestAnimationFrame(() => {
            this.layoutFrame = 0;
            this.layout();
        });
    }
    notify() {
        this.viewer.emitPresentationChange(this.state);
    }
    on(target, type, listener) {
        target.addEventListener(type, listener);
        this.listeners.push({ target, type, listener });
    }
    attach(documentRef, overlay) {
        const view = documentRef.defaultView || window;
        this.on(documentRef, 'keydown', (event) => this.handleKey(event));
        this.on(overlay, 'click', (event) => this.handleClick(event));
        this.on(overlay, 'contextmenu', (event) => {
            event.preventDefault();
            this.previous();
        });
        this.on(view, 'resize', () => this.scheduleLayout());
        this.on(documentRef, 'fullscreenchange', () => {
            if (this.ownsFullscreen && !this.isFullscreenElement(overlay)) {
                this.ownsFullscreen = false;
                this.exit();
            }
        });
    }
    detach() {
        for (const { target, type, listener } of this.listeners) {
            target.removeEventListener(type, listener);
        }
        this.listeners = [];
    }
    handleClick(event) {
        var _a;
        const overlay = this.overlay;
        if (!overlay || ((_a = event.target) === null || _a === void 0 ? void 0 : _a.closest('.flyfish-pptx-presentation-exit'))) {
            return;
        }
        const bounds = overlay.getBoundingClientRect();
        const ratio = (event.clientX - bounds.left) / (bounds.width || 1);
        if (ratio < 0.2) {
            this.previous();
        }
        else {
            this.next();
        }
    }
    handleKey(event) {
        if (!this.active || event.altKey || event.metaKey || event.ctrlKey) {
            return;
        }
        const target = event.target;
        if (target &&
            typeof target.closest === 'function' &&
            target.closest('button, a, input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
            return;
        }
        if (target && typeof target.closest === 'function') {
            const otherOverlay = target.closest('.flyfish-pptx-presentation');
            if (otherOverlay && otherOverlay !== this.overlay) {
                return;
            }
        }
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
            case 'PageDown':
            case ' ':
            case 'Enter':
                event.preventDefault();
                this.next();
                break;
            case 'ArrowLeft':
            case 'ArrowUp':
            case 'PageUp':
            case 'Backspace':
                event.preventDefault();
                this.previous();
                break;
            case 'Home':
                event.preventDefault();
                this.goTo(1);
                break;
            case 'End':
                event.preventDefault();
                this.goTo(this.viewer.slideCount);
                break;
            case 'Escape':
                event.preventDefault();
                this.exit();
                break;
            default:
                break;
        }
    }
}
