import { getTopSellingProducts } from '../services/topProductsService.js'

export async function getTopProducts(req, res) {
  res.json(await getTopSellingProducts({ ...req.query, shop: req.user.shopId }))
}
