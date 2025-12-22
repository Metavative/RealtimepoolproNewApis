export function requireCsrf(req, res, next) {
    try {
      const cookieToken = req.cookies?.csrf_token;
      const headerToken = req.headers["x-csrf-token"];
  
      if (!cookieToken || !headerToken) {
        return res.status(403).json({ message: "CSRF token missing" });
      }
  
      if (String(cookieToken) !== String(headerToken)) {
        return res.status(403).json({ message: "CSRF token invalid" });
      }
  
      return next();
    } catch (err) {
      return res.status(403).json({ message: "CSRF validation failed" });
    }
  }