export default class CardGalleryTool {
    static get toolbox() {
        return {
            title: 'Card Gallery',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15L16 10L5 21" stroke="currentColor" stroke-width="2"/></svg>'
        };
    }


    constructor({ data, api, config }) {
        this.api = api;
        this.data = data;
        this.config = config || {};
    }

    render() {
        const wrapper = document.createElement('div');
        wrapper.className = 'w-full p-6 border-2 border-dashed border-blue-200 rounded-xl bg-blue-50 flex flex-col items-center justify-center my-4 transition-colors hover:border-blue-400 cursor-grab';

        wrapper.innerHTML = `
            <div class="text-4xl mb-2">📸</div>
            <h3 class="text-lg font-bold text-blue-800">Card Gallery Placeholder</h3>
            <p class="text-sm text-blue-600">This section will display your Promo Cards in ZigZag layout.</p>
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
