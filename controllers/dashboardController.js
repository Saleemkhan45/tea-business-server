import { getDashboard } from '../services/dashboardService.js'
export async function getDashboardSummary(req, res) {
  const started = performance.now()
  const data = await getDashboard({ ...req.query, shop: req.user.shopId })
  res.setHeader('Server-Timing', `dashboard;dur=${(performance.now() - started).toFixed(1)}`)
  res.json(data)
}

