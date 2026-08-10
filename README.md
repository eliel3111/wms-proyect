# SIDIAL WMS

**SIDIAL WMS** is a modern Warehouse Management System built with **React, TypeScript, Node.js, Express, and PostgreSQL** to help companies manage warehouse operations, inventory, receiving, picking, transfers, and shipping from a centralized platform.

The system is designed to integrate with different **Enterprise Resource Planning (ERP)** platforms, allowing businesses to keep their ERP as the main business system while SIDIAL WMS handles day-to-day warehouse operations.

---

## 🛠️ Technologies

### Frontend

* React
* TypeScript
* Vite
* CSS
* Progressive Web App (PWA)
* WebSockets
* REST APIs

### Backend

* Node.js
* Express.js
* JavaScript / TypeScript
* REST APIs
* SOAP integrations
* XML parsing
* Background workers
* Cron jobs

### Database

* PostgreSQL

### Authentication & Security

* JSON Web Tokens (JWT)
* Access & refresh tokens
* HTTP-only cookies
* Role-based permissions

### Infrastructure

* Linux / Ubuntu
* Nginx
* PM2
* PostgreSQL
* HTTPS / SSL
* Cloud VPS infrastructure

---

## 🚀 Core Features

### 📥 Purchase Order Receiving

SIDIAL WMS syncs purchase orders from external ERPs and enables warehouse employees to receive merchandise directly through the WMS.

Supports:

* Partial and multiple receiving
* Barcode scanning
* Location assignment
* Quantity validation
* Backorders
* Receiving discrepancies
* ERP product validation
* Supplier billing
* Automatic inventory updates

### 📦 Picking

A location-aware picking system for preparing customer orders.

The system can:

* Reserve inventory
* Recommend picking locations
* Validate scanned locations
* Validate product quantities
* Track completed quantities
* Support partial picking
* Split incomplete lines
* Prevent over-picking
* Close completed picking operations

Warehouse behavior can be configured based on whether inventory must be associated with specific warehouse locations.

### 📷 Barcode Scanning

Warehouse users can scan:

* Products
* SKUs
* Barcodes
* Warehouse locations

The scanning workflow is designed for handheld warehouse devices where barcode scanners operate as keyboard input.

### 🏭 Warehouse Locations

Inventory can be managed by specific warehouse locations using a hierarchical structure:

**Warehouse → Aisle → Rack → Shelf → Bin**

Example location:

`GC-P3-C2-T02-N12`

Each inventory movement can be associated with its physical warehouse location.

### 📍 Putaway

After receiving merchandise, warehouse employees can move products from receiving areas to designated storage locations.

### 🔄 Inventory Transfers

Products can be transferred between warehouse locations while maintaining inventory traceability.

### 📊 Inventory Management

Inventory is tracked by:

**Warehouse + Location + Product**

The system maintains:

* Quantity on hand
* Reserved quantity
* Available quantity
* Previous quantity
* Physical count
* Inventory variance

### 🔧 Inventory Adjustments

SIDIAL WMS synchronizes inventory differences with the ERP using **resumable adjustment jobs**.

Large adjustments are processed individually with `pending`, `success`, and `failed` statuses, allowing failed operations to be retried without restarting the entire process—even after network, ERP, frontend, or application interruptions.

### 🔗 ERP Integration

SIDIAL WMS is designed to work alongside existing ERP systems rather than replace them.

ERP integrations can use:

* REST APIs
* SOAP Web Services
* JSON
* XML

The integration layer is designed to support different ERP providers without changing the core warehouse workflows.

### 🏢 Multi-Company Architecture

SIDIAL WMS is designed to support multiple companies and different ERP environments.

### 🔐 User Roles & Permissions

The application uses permission-based access control to manage user access to warehouse operations and system functionality.

### 📱 Progressive Web Application

The frontend is implemented as a **Progressive Web Application (PWA)**, providing an app-like experience without requiring a traditional mobile application installation.

The interface is designed for:

* Desktop computers
* Tablets
* Android PDAs

---

# 📈 Project Progress

## 👨‍💻 The Process

I started SIDIAL WMS by building the foundation of the warehouse application with **React, TypeScript, Node.js, Express, and PostgreSQL**.

The initial goal was to create a system capable of managing inventory operations while remaining flexible enough to connect with the different ERP platforms already used by each company.

### Receiving & Inventory

I first focused on the receiving process. I built workflows for importing purchase orders from an ERP, validating products, scanning barcodes, receiving partial or complete quantities, handling discrepancies, and updating inventory.

From there, I introduced warehouse locations so products could be tracked not only by quantity but also by their physical position inside the warehouse.

### Putaway & Transfers

Next, I developed putaway, inventory transfers, and location-based inventory.

The system was designed around **warehouse, product, and location relationships**, allowing operators to scan products and locations directly from Android PDAs and barcode scanners.

The frontend was built as a responsive PWA so warehouse employees could use the same application from desktop computers, tablets, or handheld devices.

### Picking

After establishing the inventory foundation, I developed the picking workflow.

This included:

* Inventory reservations
* Suggested picking locations
* Quantity validation
* Partial picking
* Completed quantities
* Rules preventing users from picking more inventory than available

I also added configurable behavior so companies can use different warehouse and picking rules based on their operations.

### Cycle Counting & Inventory Adjustments

I then developed cycle-counting and inventory adjustment workflows.

Physical quantities can be compared against system inventory, reviewed, and synchronized with the connected ERP.

For large adjustments involving thousands of products, I designed **resumable background jobs** that process inventory changes individually, track successful and failed operations, retry errors, and continue even when the frontend is closed or an ERP request temporarily fails.

### ERP Integration

ERP integration became another major part of the project.

I created backend services capable of communicating with external systems through **REST APIs and SOAP Web Services**, handling JSON and XML responses, authentication, timeouts, errors, and different testing and production environments.

This allows SIDIAL WMS to act as the warehouse operations layer while the ERP continues managing purchasing, sales, accounting, and enterprise data.

### Authentication & Infrastructure

Along the way, I implemented:

* JWT authentication
* Role-based permissions
* Reporting
* Scheduled synchronization jobs
* WebSocket communication
* Database transactions
* Row locking
* Error handling
* Production deployment

The application can be deployed using **Nginx, PM2, PostgreSQL, and Linux infrastructure**.

### Continuous Development

Building SIDIAL WMS has been an iterative process. Each new warehouse workflow has required understanding both the software problem and the real operational process behind it.

As the project continues to grow, I document business rules, integration decisions, database behavior, deployment procedures, and lessons learned to keep the system maintainable and ready to support additional companies, warehouses, and ERP integrations.

---

## 🎯 Project Goals

* Improve warehouse inventory accuracy
* Reduce manual warehouse processes
* Accelerate receiving and picking operations
* Provide real-time inventory visibility
* Support barcode-based workflows
* Integrate with existing ERP systems
* Create a scalable foundation for multiple companies and warehouses

---

## 👨‍💻 Author

**Eliel Rodriguez**

Full-Stack Software Engineer | React | TypeScript | Node.js | PostgreSQL

📍 New York City

[LinkedIn](https://www.linkedin.com/in/elielrodriguez/)

📧 [eliel3111@gmail.com](mailto:eliel3111@gmail.com)
