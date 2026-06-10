import { useState, useEffect, useCallback, useRef } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { OrdersTable } from './components/OrdersTable';
import { OrderDetailDialog } from './components/OrderDetailDialog';
import { FilterControls } from './components/FilterControls';
import { Button } from './components/ui/button';

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

const api = {
  async login(password: string) {
    const response = await fetch('/dashboard-api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error('Invalid credentials');

    const data = await response.json().catch(() => ({}));
    const sessionToken = response.headers.get('X-Session-Token') || data.token;
    if (sessionToken) {
      localStorage.setItem('session_token', sessionToken);
    }
    return response;
  },

  async logout() {
    await fetch('/dashboard-api/logout', { method: 'POST' });
  },

  getHeaders(): Record<string, string> {
    const token = localStorage.getItem('session_token');
    if (!token) return {};
    return { 'X-Session-Token': token };
  },

  async getOrders({ status, limit = 50, offset = 0 }: { status?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());

    const headers = this.getHeaders();
    const response = await fetch(`/dashboard-api/orders?${params}`, { headers });
    if (!response.ok) throw new Error('Unauthorized');
    return response.json();
  },

  async getOrder(displayId: string) {
    const headers = this.getHeaders();
    const response = await fetch(`/dashboard-api/orders/${encodeURIComponent(displayId)}`, { headers });
    if (!response.ok) throw new Error('Unauthorized');
    return response.json();
  },
};

export interface Order {
  display_id: string;
  customer_name: string;
  customer_username?: string;
  status: string;
  created_at: string;
  item_count: number;
  customer: {
    name: string;
    username?: string;
  };
  items: { link: string }[];
  specs?: string;
  transitions: {
    from_status: string | null;
    to_status: string;
    changed_by: string;
    created_at: string;
  }[];
}

interface OrdersResponse {
  orders: Order[];
  total: number;
}

export function DashboardApp() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem('session_token');
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [currentSort, setCurrentSort] = useState({ column: 'created_at', direction: 'desc' as 'asc' | 'desc' });
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [pagination, setPagination] = useState({ page: 1, total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark';
  });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialized = useRef(false);

  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    const token = localStorage.getItem('session_token');
    if (token) {
      loadOrdersInternal();
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', darkMode ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const loadOrdersInternal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getOrders({
        status: filters.status || undefined,
        limit: PAGE_SIZE,
        offset: (pagination.page - 1) * PAGE_SIZE,
      }) as OrdersResponse;
      setOrders(response.orders);
      setPagination(prev => ({ ...prev, total: response.total }));
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        localStorage.removeItem('session_token');
        setIsAuthenticated(false);
        setOrders([]);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load orders');
      }
    } finally {
      setLoading(false);
    }
  }, [filters.status, pagination.page]);

  const handleLogin = async (password: string) => {
    try {
      await api.login(password);
      setIsAuthenticated(true);
      setFilters({ status: '', search: '' });
      setPagination({ page: 1, total: 0 });
      loadOrdersInternal();
    } catch {
      throw new Error('Invalid credentials');
    }
  };

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      localStorage.removeItem('session_token');
      setIsAuthenticated(false);
      setOrders([]);
    }
  }, []);

  const handleSort = (column: string) => {
    setCurrentSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const handleStatusFilterChange = (status: string) => {
    setFilters(prev => ({ ...prev, status }));
    setPagination(prev => ({ ...prev, page: 1 }));
    loadOrdersInternal();
  };

  const handleSearchChange = useCallback((search: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    // Per spec 002 FR-005: minimum 2 characters required to trigger search.
    // Empty string clears the filter (shows all orders). 1-char input is ignored
    // so the user can finish typing before we fire an API call.
    if (search.length > 0 && search.length < 2) return;
    debounceTimerRef.current = setTimeout(() => {
      setFilters(prev => ({ ...prev, search }));
      setPagination(prev => ({ ...prev, page: 1 }));
      loadOrdersInternal();
    }, DEBOUNCE_MS);
  }, [loadOrdersInternal]);

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
    loadOrdersInternal();
  };

  const handleRowClick = async (displayId: string) => {
    try {
      const response = await api.getOrder(displayId);
      setSelectedOrder(response.order);
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        handleLogout();
      } else {
        alert('Failed to load order details: ' + (err instanceof Error ? err.message : 'Unknown error'));
      }
    }
  };

  const sortedOrders = [...orders].sort((a, b) => {
    let aVal = a[currentSort.column as keyof Order];
    let bVal = b[currentSort.column as keyof Order];

    if (currentSort.column === 'created_at') {
      aVal = new Date(aVal as string).getTime();
      bVal = new Date(bVal as string).getTime();
    }

    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const filteredOrders = filters.search
    ? sortedOrders.filter(order =>
        order.customer_name.toLowerCase().includes(filters.search.toLowerCase()) ||
        (order.customer_username && order.customer_username.toLowerCase().includes(filters.search.toLowerCase()))
      )
    : sortedOrders;

  if (!isAuthenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDarkMode(!darkMode)}
            >
              {darkMode ? 'Light' : 'Dark'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <FilterControls
          status={filters.status}
          search={filters.search}
          onStatusChange={handleStatusFilterChange}
          onSearchChange={handleSearchChange}
        />

        <OrdersTable
          orders={filteredOrders}
          loading={loading}
          error={error}
          sortColumn={currentSort.column}
          sortDirection={currentSort.direction}
          onSort={handleSort}
          onRowClick={handleRowClick}
          pagination={{
            page: pagination.page,
            total: pagination.total,
            pageSize: PAGE_SIZE,
            onPageChange: handlePageChange,
          }}
        />
      </main>

      <OrderDetailDialog
        order={selectedOrder}
        open={!!selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </div>
  );
}