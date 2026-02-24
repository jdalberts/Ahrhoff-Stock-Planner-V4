export class AgriDB {
  private dbName = 'AgriStockDB';
  private version = 4;
  private dbPromise: Promise<IDBDatabase> | null = null;

  async init(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version);

        request.onupgradeneeded = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains('items')) database.createObjectStore('items', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('lots')) database.createObjectStore('lots', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('stockCounts')) database.createObjectStore('stockCounts', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('sales')) database.createObjectStore('sales', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('salesTransactions')) database.createObjectStore('salesTransactions', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('alerts')) database.createObjectStore('alerts', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('customers')) database.createObjectStore('customers', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('orders')) database.createObjectStore('orders', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('order_lines')) database.createObjectStore('order_lines', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('products')) database.createObjectStore('products', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('import_batches')) database.createObjectStore('import_batches', { keyPath: 'id' });
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          this.dbPromise = null;
          reject(request.error);
        };
      });
    }
    return this.dbPromise;
  }

  async getAll<T>(storeName: string): Promise<T[]> {
    const database = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async put<T>(storeName: string, data: T): Promise<void> {
    const database = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName: string, id: string): Promise<void> {
    const database = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(storeName: string): Promise<void> {
    const database = await this.init();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const db = new AgriDB();
