<template>
  <div class="restocking">
    <div class="page-header">
      <h2>{{ t('restocking.title') }}</h2>
      <p>{{ t('restocking.description') }}</p>
    </div>

    <div class="card budget-card">
      <label class="budget-label" for="budget-range">{{ t('restocking.budgetLabel') }}</label>
      <div class="budget-controls">
        <input id="budget-range" v-model.number="budget" type="range" min="0" max="50000" step="500" class="budget-slider" />
        <input v-model.number="budget" type="number" min="0" max="50000" step="500" class="budget-number" :aria-label="t('restocking.budget')" />
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card info">
        <div class="stat-label">{{ t('restocking.budget') }}</div>
        <div class="stat-value">{{ formatCurrency(budget, currentCurrency) }}</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-label">{{ t('restocking.selectedTotal') }}</div>
        <div class="stat-value">{{ formatCurrency(selectedTotal, currentCurrency) }}</div>
      </div>
      <div :class="['stat-card', remainingBudget < 0 ? 'danger' : 'success']">
        <div class="stat-label">{{ t('restocking.remainingBudget') }}</div>
        <div class="stat-value">{{ formatCurrency(remainingBudget, currentCurrency) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">{{ t('restocking.selectedItems') }}</div>
        <div class="stat-value">{{ selectedItems.length }} / {{ recommendations.length }}</div>
      </div>
    </div>

    <div v-if="successOrder" class="notice success-notice">
      {{ t('restocking.orderSuccess', { orderNumber: successOrder }) }}
      <router-link to="/orders">{{ t('restocking.viewInOrders') }}</router-link>
    </div>
    <div v-if="submitError" class="notice error-notice">{{ submitError }}</div>

    <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <div v-else class="card">
      <div class="card-header header-row">
        <h3 class="card-title">{{ t('restocking.recommendations') }} ({{ recommendations.length }})</h3>
        <button class="place-order-btn" :disabled="selectedItems.length === 0 || submitting" @click="placeOrder">
          {{ submitting ? t('restocking.submitting') : t('restocking.placeOrder') }}
        </button>
      </div>
      <div v-if="recommendations.length === 0" class="empty-state">{{ t('restocking.noRecommendations') }}</div>
      <div v-else class="table-container">
        <table>
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" :checked="allSelected" :aria-label="t('restocking.selectAll')" @change="toggleAll($event.target.checked)" />
              </th>
              <th>{{ t('restocking.table.sku') }}</th>
              <th>{{ t('restocking.table.name') }}</th>
              <th>{{ t('restocking.table.trend') }}</th>
              <th>{{ t('restocking.table.quantity') }}</th>
              <th>{{ t('restocking.table.unitCost') }}</th>
              <th>{{ t('restocking.table.lineTotal') }}</th>
              <th>{{ t('restocking.table.leadTime') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in recommendations" :key="item.sku">
              <td class="col-check"><input v-model="selectedSkus" type="checkbox" :value="item.sku" /></td>
              <td><strong>{{ item.sku }}</strong></td>
              <td>{{ item.name }}</td>
              <td><span :class="['badge', item.trend]">{{ t(`trends.${item.trend}`) }}</span></td>
              <td>{{ item.quantity }}</td>
              <td>{{ formatCurrencyWithDecimals(item.unit_cost, currentCurrency, 2) }}</td>
              <td><strong>{{ formatCurrencyWithDecimals(item.line_total, currentCurrency, 2) }}</strong></td>
              <td>{{ item.lead_time_days }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { api } from '../api'
import { useI18n } from '../composables/useI18n'
import { formatCurrency, formatCurrencyWithDecimals } from '../utils/currency'

export default {
  name: 'Restocking',
  setup() {
    const { t, currentCurrency } = useI18n()

    const budget = ref(10000)
    const recommendations = ref([])
    const selectedSkus = ref([])
    const loading = ref(true)
    const error = ref(null)
    const submitting = ref(false)
    const submitError = ref(null)
    const successOrder = ref(null)

    const selectedItems = computed(() =>
      recommendations.value.filter(item => selectedSkus.value.includes(item.sku))
    )
    const selectedTotal = computed(() =>
      selectedItems.value.reduce((sum, item) => sum + item.line_total, 0)
    )
    const remainingBudget = computed(() => budget.value - selectedTotal.value)
    const allSelected = computed(() =>
      recommendations.value.length > 0 && selectedItems.value.length === recommendations.value.length
    )

    // Sequence counter so a slow, stale response can't overwrite a newer one
    let requestSeq = 0

    const loadRecommendations = async () => {
      const seq = ++requestSeq
      try {
        loading.value = true
        error.value = null
        const data = await api.getRestockRecommendations(budget.value)
        if (seq !== requestSeq) return
        recommendations.value = data
        // Default to select-all after every fetch: the backend already fits the list within budget
        selectedSkus.value = data.map(item => item.sku)
      } catch (err) {
        if (seq !== requestSeq) return
        error.value = t('restocking.loadFailed') + ': ' + (err.response?.data?.detail || err.message)
      } finally {
        if (seq === requestSeq) loading.value = false
      }
    }

    // Debounce: the slider fires on every step while dragging; wait 300ms of
    // inactivity before hitting the API. Invalid/empty number input is ignored.
    let debounceTimer = null
    watch(budget, (value) => {
      if (typeof value !== 'number' || isNaN(value) || value < 0) return
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(loadRecommendations, 300)
    })

    const toggleAll = (checked) => {
      selectedSkus.value = checked ? recommendations.value.map(item => item.sku) : []
    }

    const placeOrder = async () => {
      if (selectedItems.value.length === 0 || submitting.value) return
      submitting.value = true
      submitError.value = null
      successOrder.value = null
      try {
        const order = await api.createRestockOrder({
          budget: budget.value,
          items: selectedItems.value.map(({ sku, name, quantity, unit_cost, lead_time_days }) => (
            { sku, name, quantity, unit_cost, lead_time_days }
          ))
        })
        successOrder.value = order.order_number
        await loadRecommendations()
      } catch (err) {
        const detail = err.response?.data?.detail
        submitError.value = t('restocking.orderFailed') + ': ' + (typeof detail === 'string' ? detail : err.message)
      } finally {
        submitting.value = false
      }
    }

    onMounted(loadRecommendations)
    onBeforeUnmount(() => clearTimeout(debounceTimer))

    return {
      t,
      currentCurrency,
      formatCurrency,
      formatCurrencyWithDecimals,
      budget,
      recommendations,
      selectedSkus,
      selectedItems,
      selectedTotal,
      remainingBudget,
      allSelected,
      loading,
      error,
      submitting,
      submitError,
      successOrder,
      toggleAll,
      placeOrder
    }
  }
}
</script>

<style scoped>
.budget-card {
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.budget-label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
}

.budget-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.budget-slider {
  flex: 1;
}

.budget-number {
  width: 120px;
  padding: 0.5rem 0.75rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  color: #0f172a;
  font-size: 0.875rem;
}

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.place-order-btn {
  padding: 0.5rem 1.25rem;
  background: #0f172a;
  color: white;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
}

.place-order-btn:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
}

.col-check {
  width: 40px;
}

.notice {
  padding: 0.75rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

.success-notice {
  background: #d1fae5;
  color: #065f46;
  border: 1px solid #10b981;
}

.success-notice a {
  margin-left: 0.5rem;
  color: #065f46;
  font-weight: 600;
  text-decoration: underline;
}

.error-notice {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #ef4444;
}

.empty-state {
  padding: 1.5rem;
  color: #64748b;
  text-align: center;
}
</style>
