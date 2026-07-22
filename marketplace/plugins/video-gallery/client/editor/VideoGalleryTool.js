export default class VideoGalleryTool {
    static get toolbox() {
        return {
            title: 'Video Gallery',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M10 9L15 12L10 15V9Z" fill="currentColor"/></svg>'
        };
    }

    constructor({ data, api, config }) {
        this.api = api;
        this.data = data;
        this.config = config || {};
    }

    render() {
        const wrapper = document.createElement('div');
        wrapper.className = 'w-full p-6 border-2 border-dashed border-cyan-200 rounded-xl bg-cyan-50 flex flex-col items-center justify-center my-4 transition-colors hover:border-cyan-400 cursor-grab';

        wrapper.innerHTML = `
            <div class="text-4xl mb-2">🎬</div>
            <h3 class="text-lg font-bold text-cyan-800">Video Gallery</h3>
            <p class="text-sm text-cyan-600">This section will display your videos in a horizontal carousel.</p>
        `;

        return wrapper;
    }

    rendered() {
        if (this.config && this.config.triggerChange) {
            this.config.triggerChange();
        }
    }

    save() {
        return {
            inserted: true
        };
    }
}
