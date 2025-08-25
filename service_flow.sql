-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: localhost:3306
-- Generation Time: Aug 25, 2025 at 07:09 PM
-- Server version: 8.0.42-cll-lve
-- PHP Version: 8.4.10

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `service_flow`
--

-- --------------------------------------------------------

--
-- Table structure for table `booking_settings`
--

CREATE TABLE `booking_settings` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `settings` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

--
-- Dumping data for table `booking_settings`
--

INSERT INTO `booking_settings` (`id`, `user_id`, `settings`, `created_at`, `updated_at`) VALUES
(1, 3, '{\"branding\":{\"primaryColor\":\"#4CAF50\",\"headerBackground\":\"#ffffff\",\"headerIcons\":\"#4CAF50\",\"hideZenbookerBranding\":false,\"logo\":\"/uploads/profile-1752911023422-621424681.png\",\"favicon\":null,\"heroImage\":null},\"content\":{\"heading\":\"Book Online\",\"text\":\"Let\'s get started by entering your postal code.\"},\"general\":{\"serviceArea\":\"postal-code\",\"serviceLayout\":\"default\",\"datePickerStyle\":\"available-days\",\"language\":\"english\",\"textSize\":\"big\",\"showPrices\":false,\"includeTax\":false,\"autoAdvance\":true,\"allowCoupons\":true,\"showAllOptions\":false,\"showEstimatedDuration\":false,\"limitAnimations\":false,\"use24Hour\":false,\"allowMultipleServices\":false},\"analytics\":{\"googleAnalytics\":\"\",\"facebookPixel\":\"\"},\"customUrl\":\"\"}', '2025-07-19 07:25:58', '2025-07-19 07:43:43'),
(2, 6, '{\"branding\":{\"primaryColor\":\"#4CAF50\",\"headerBackground\":\"#ffffff\",\"headerIcons\":\"#4CAF50\",\"hideZenbookerBranding\":false,\"logo\":null,\"favicon\":null,\"heroImage\":null},\"content\":{\"heading\":\"Book Online\",\"text\":\"Let\'s get started by entering your postal code.\"},\"general\":{\"serviceArea\":\"postal-code\",\"serviceLayout\":\"default\",\"datePickerStyle\":\"available-days\",\"language\":\"english\",\"textSize\":\"big\",\"showPrices\":false,\"includeTax\":false,\"autoAdvance\":true,\"allowCoupons\":true,\"showAllOptions\":false,\"showEstimatedDuration\":false,\"limitAnimations\":false,\"use24Hour\":false,\"allowMultipleServices\":false},\"analytics\":{\"googleAnalytics\":\"\",\"facebookPixel\":\"\"},\"customUrl\":\"\"}', '2025-07-22 19:06:09', '2025-07-22 19:06:09'),
(3, 7, '{\"branding\":{\"primaryColor\":\"#4CAF50\",\"headerBackground\":\"#ffffff\",\"headerIcons\":\"#4CAF50\",\"hideZenbookerBranding\":false,\"logo\":null,\"favicon\":null,\"heroImage\":null},\"content\":{\"heading\":\"Book Online\",\"text\":\"Let\'s get started by entering your postal code.\"},\"general\":{\"serviceArea\":\"postal-code\",\"serviceLayout\":\"default\",\"datePickerStyle\":\"available-days\",\"language\":\"english\",\"textSize\":\"big\",\"showPrices\":false,\"includeTax\":false,\"autoAdvance\":true,\"allowCoupons\":true,\"showAllOptions\":false,\"showEstimatedDuration\":false,\"limitAnimations\":false,\"use24Hour\":false,\"allowMultipleServices\":false},\"analytics\":{\"googleAnalytics\":\"\",\"facebookPixel\":\"\"},\"customUrl\":\"\"}', '2025-07-26 21:33:31', '2025-07-26 21:33:31'),
(4, 5, '{\"branding\":{\"primaryColor\":\"#4CAF50\",\"headerBackground\":\"#ffffff\",\"headerIcons\":\"#4CAF50\",\"hideZenbookerBranding\":false,\"logo\":null,\"favicon\":null,\"heroImage\":null},\"content\":{\"heading\":\"Book Online\",\"text\":\"Let\'s get started by entering your postal code.\"},\"general\":{\"serviceArea\":\"postal-code\",\"serviceLayout\":\"default\",\"datePickerStyle\":\"available-days\",\"language\":\"english\",\"textSize\":\"big\",\"showPrices\":false,\"includeTax\":false,\"autoAdvance\":true,\"allowCoupons\":true,\"showAllOptions\":false,\"showEstimatedDuration\":false,\"limitAnimations\":false,\"use24Hour\":false,\"allowMultipleServices\":false},\"analytics\":{\"googleAnalytics\":\"\",\"facebookPixel\":\"\"},\"customUrl\":\"\"}', '2025-08-06 16:40:10', '2025-08-06 16:40:10');

-- --------------------------------------------------------

--
-- Table structure for table `coupons`
--

CREATE TABLE `coupons` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `code` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `discount_type` enum('percentage','fixed') COLLATE utf8mb4_general_ci NOT NULL,
  `discount_amount` decimal(10,2) NOT NULL,
  `application_type` enum('all','specific') COLLATE utf8mb4_general_ci DEFAULT 'all',
  `selected_services` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `doesnt_expire` tinyint(1) DEFAULT '0',
  `expiration_date` date DEFAULT NULL,
  `restrict_before_expiration` tinyint(1) DEFAULT '0',
  `limit_total_uses` tinyint(1) DEFAULT '0',
  `total_uses_limit` int DEFAULT NULL,
  `current_uses` int DEFAULT '0',
  `can_combine_with_recurring` tinyint(1) DEFAULT '0',
  `recurring_application_type` enum('all','first') COLLATE utf8mb4_general_ci DEFAULT 'all',
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

--
-- Dumping data for table `coupons`
--

INSERT INTO `coupons` (`id`, `user_id`, `code`, `discount_type`, `discount_amount`, `application_type`, `selected_services`, `doesnt_expire`, `expiration_date`, `restrict_before_expiration`, `limit_total_uses`, `total_uses_limit`, `current_uses`, `can_combine_with_recurring`, `recurring_application_type`, `is_active`, `created_at`, `updated_at`) VALUES
(1, 3, 'COUPON-QURP0M', 'fixed', 10.00, 'specific', '[1]', 1, NULL, 0, 1, NULL, 0, 0, 'first', 1, '2025-07-19 21:38:52', '2025-07-19 21:38:52'),
(2, 3, 'TEST50', 'percentage', 50.00, 'all', '[]', 1, NULL, 0, 0, NULL, 0, 0, 'all', 1, '2025-07-19 21:56:46', '2025-07-19 22:11:42');

-- --------------------------------------------------------

--
-- Table structure for table `coupon_usage`
--

CREATE TABLE `coupon_usage` (
  `id` int NOT NULL,
  `coupon_id` int NOT NULL,
  `customer_id` int NOT NULL,
  `job_id` int DEFAULT NULL,
  `invoice_id` int DEFAULT NULL,
  `used_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `discount_amount` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `customers`
--

CREATE TABLE `customers` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `last_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `address` text COLLATE utf8mb4_general_ci,
  `suite` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `city` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `state` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `zip_code` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `notes` text COLLATE utf8mb4_general_ci,
  `status` enum('active','inactive','archived') COLLATE utf8mb4_general_ci DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `customers`
--

INSERT INTO `customers` (`id`, `user_id`, `first_name`, `last_name`, `email`, `phone`, `address`, `suite`, `city`, `state`, `zip_code`, `notes`, `status`, `created_at`, `updated_at`) VALUES
(1, 3, 'OLAMILEKAN', 'AJAJA', 'ajajaolamilekan7@gmail.com', '09030844572', '146 NITEL JUNCTION 146 Nitel Junction State', '', NULL, NULL, NULL, NULL, 'active', '2025-07-15 02:01:46', '2025-07-18 23:42:25'),
(2, 3, 'John', 'Doe', 'john.doe@example.com', '+1234567890', '123 Main Street', '', NULL, NULL, NULL, 'VIP customer - prefers morning appointments', 'active', '2025-07-15 02:06:54', '2025-07-15 02:06:54'),
(3, 3, 'Jane', 'Smith', 'jane.smith@email.com', '+1987654321', '456 Oak Avenue', '', NULL, NULL, NULL, 'Regular cleaning customer', 'active', '2025-07-15 02:06:54', '2025-07-15 02:06:54'),
(4, 3, 'Mike', 'Johnson', 'mike.j@business.com', '+1555123456', '789 Pine Road', '', NULL, NULL, NULL, 'New customer - interested in deep cleaning', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:55:32'),
(5, 3, 'Sarah', 'Williams', 'sarah.w@test.com', '+1444333222', '321 Elm Street', '', NULL, NULL, NULL, 'Referred by Jane Smith', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:55:19'),
(6, 3, 'David', 'Brown', 'david.brown@mail.com', '+1777888999', '654 Maple Drive', '', NULL, NULL, NULL, 'Commercial client - office cleaning', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:55:26'),
(7, 3, 'Lisa', 'Davis', 'lisa.davis@company.com', '+1666777888', '987 Cedar Lane', '', NULL, NULL, NULL, 'Weekly maintenance customer', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:54:59'),
(8, 3, 'Robert', 'Wilson', 'robert.w@enterprise.com', '+1888999000', '147 Birch Court', '', NULL, NULL, NULL, 'One-time deep cleaning request', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:55:13'),
(9, 3, 'Emily', 'Taylor', 'emily.t@corp.com', '+1999000111', '258 Spruce Way', '', NULL, NULL, NULL, 'Regular customer - every 2 weeks', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:55:08'),
(10, 3, 'James', 'Anderson', 'james.a@firm.com', '+1222333444', '369 Willow Place', '', NULL, NULL, NULL, 'New construction cleanup', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:54:49'),
(11, 3, 'Amanda', 'Thomas', 'amanda.t@agency.com', '+1111222333', '741 Aspen Circle', '', NULL, NULL, NULL, 'Move-out cleaning specialist', 'archived', '2025-07-15 02:06:54', '2025-07-24 06:54:44'),
(12, 1, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon0@gmail.com', '08107370125', '6 opposite school gate, iworoko rd, osekita', '', NULL, NULL, NULL, NULL, 'active', '2025-07-18 21:34:20', '2025-07-18 21:34:20'),
(13, 1, 'OLAMILEKAN', 'AJAJA', 'ajajaolamilekan7@gmail.com', '09030844572', '146 NITEL JUNCTION 146 Nitel Junction State', '', NULL, NULL, NULL, NULL, 'active', '2025-07-18 21:36:23', '2025-07-18 21:36:23'),
(14, 3, 'jamsy', '', 'adeniyiadejuwon0@gmail.com', '08107470125', '27, streeet', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 02:52:27', '2025-07-22 19:40:56'),
(15, 4, 'John', 'Smith', 'john.smith@email.com', '+1 (555) 123-4567', '123 Main Street, City, State 12345', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 21:04:53', '2025-07-19 21:04:53'),
(16, 4, 'Sarah', 'Johnson', 'sarah.johnson@email.com', '+1 (555) 234-5678', '456 Oak Avenue, City, State 12345', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 21:04:53', '2025-07-19 21:04:53'),
(17, 4, 'Michael', 'Davis', 'michael.davis@email.com', '+1 (555) 345-6789', '789 Pine Road, City, State 12345', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 21:04:53', '2025-07-19 21:04:53'),
(18, 4, 'Emily', 'Wilson', 'emily.wilson@email.com', '+1 (555) 456-7890', '321 Elm Street, City, State 12345', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 21:04:53', '2025-07-19 21:04:53'),
(19, 4, 'David', 'Brown', 'david.brown@email.com', '+1 (555) 567-8901', '654 Maple Drive, City, State 12345', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 21:04:53', '2025-07-19 21:04:53'),
(20, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon@gmail.com', '08107370125', '6 opposite school gate, iworoko rd, osekita', '', NULL, NULL, NULL, NULL, 'active', '2025-07-19 22:20:41', '2025-07-19 22:20:41'),
(21, 6, 'Ajaja', 'Joshua', 'joshua@now2code.com', '09030844572', '8b Furo Ezimora St, Lekki Phase 1', '', NULL, NULL, NULL, NULL, 'active', '2025-07-22 19:11:39', '2025-07-22 19:11:39'),
(22, 6, 'oyewole', 'precious anuoluwapo', 'preciousanuoluwapo07@gmail.com', '09151596345', 'orogun, ibadan', '', NULL, NULL, NULL, NULL, 'archived', '2025-07-22 19:27:37', '2025-07-27 13:38:17'),
(23, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.com', '2483462681', '5631 Raven Ct.', '', NULL, NULL, NULL, 'Customer record 1', 'archived', '2025-07-23 12:38:23', '2025-07-24 16:42:04'),
(24, 5, 'Georgiy', 'Sayapin', NULL, '2483462681', '5631 Raven Ct.', '', NULL, NULL, NULL, 'test note', 'archived', '2025-07-23 13:00:36', '2025-07-24 16:42:09'),
(25, 5, 'Georgiy', 'Sayapin', NULL, NULL, '5631 Raven Ct.', '', NULL, NULL, NULL, 'test note', 'archived', '2025-07-23 13:00:55', '2025-07-24 16:42:13'),
(26, 5, 'Georgiy', 'Sayapin', NULL, NULL, NULL, '', NULL, NULL, NULL, 'test note', 'archived', '2025-07-23 13:01:08', '2025-07-24 16:41:38'),
(27, 5, 'Georgiy', 'Sayapin', NULL, '2483462681', '5631 Raven Ct.', '', NULL, NULL, NULL, 'test note', 'archived', '2025-07-23 13:01:52', '2025-07-24 16:41:31'),
(28, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.co', '2483462681', '5631 Raven Ct.', '', NULL, NULL, NULL, 'test note', 'archived', '2025-07-23 13:06:58', '2025-07-24 16:41:23'),
(29, 5, 'Georgiy', 'Sayapin', 'prorabserv@gmail.com', '2483462681', '5631 Raven Ct.', '', NULL, NULL, NULL, 'test note', 'archived', '2025-07-23 13:10:49', '2025-07-24 16:41:15'),
(30, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.com', '(248) 346-2681', '5631 Raven Ct., 22', '', NULL, NULL, NULL, '22', 'archived', '2025-07-24 16:42:22', '2025-07-24 16:47:36'),
(31, 5, 'Kristina', 'Bugrova', NULL, '(305) 490-5875', '31240 Claridge Pl', '', NULL, NULL, NULL, NULL, 'active', '2025-07-24 16:43:29', '2025-07-24 16:43:29'),
(32, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.co', '(248) 346-2681', '5631 Raven Ct.', '', NULL, NULL, NULL, NULL, 'active', '2025-07-24 16:48:50', '2025-07-24 16:48:50'),
(33, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.com', '(248) 346-2681', '5631 Raven Ct.', '', NULL, NULL, NULL, NULL, 'archived', '2025-07-24 17:18:00', '2025-07-24 17:19:39'),
(34, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon0@gmail.com', '+88909868755', 'chelsea, 4557', '', NULL, NULL, NULL, 'everything', 'active', '2025-07-24 21:26:36', '2025-07-24 21:26:36'),
(35, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.com', '2483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA, 22', '', 'Bloomfield Hills', 'MI', '48301', '12', 'active', '2025-07-25 14:53:15', '2025-07-25 14:53:15'),
(36, 3, 'benson friday', 'N&#x2F;A', 'wevbest@gmail.com', '+2348107370125', 'Chelsea Avenue, Memphis, TN, USA, 34', '', 'Memphis', 'TN', NULL, NULL, 'archived', '2025-07-25 18:16:30', '2025-07-25 18:17:43'),
(37, 3, 'Ade', '', 'wevbest@gmail.com', '+2348107370125', 'Chelsea Piers, New York, NY, USA, 318', '', 'New York', 'NY', '10011', NULL, 'archived', '2025-07-25 18:45:21', '2025-07-25 21:53:42'),
(38, 3, 'George shaw', '', 'devwev@gmail.com', '9445329907', 'Plantation Palms Blvd, Land O&#x27; Lakes, FL, USA, 554', '', 'Land O&#x27; Lakes', 'FL', '34639', NULL, 'active', '2025-07-25 19:08:33', '2025-07-25 19:08:33'),
(39, 3, 'Idogbe', '', 'shawluke@gmail.com', '+12546864846', 'Chelsea Avenue, Memphis, TN, USA, 451', '', 'Memphis', 'TN', NULL, NULL, 'archived', '2025-07-25 21:55:22', '2025-07-25 21:59:19'),
(40, 3, 'Idogbe', '', 'shawluke@gmail.com', '+12546864846', 'Chelsea Avenue, Memphis, TN, USA, 547', '', 'Memphis', 'TN', NULL, NULL, 'active', '2025-07-25 22:00:15', '2025-07-25 22:00:15'),
(41, 3, 'Gareth', '', 'vende@gmail.com', '9556234526', 'Venice Blvd., Los Angeles, CA, USA, 667', '', 'Los Angeles', 'CA', NULL, NULL, 'archived', '2025-07-25 22:05:12', '2025-07-25 22:30:28'),
(42, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon99@gmail.com', '08107370125', 'Chelsea Piers, New York, NY, USA', '', NULL, NULL, NULL, NULL, 'active', '2025-07-26 01:33:40', '2025-07-26 01:33:40'),
(43, 3, 'dre', '', 'adeniyiadejuwonoo@gmail.com', '9017393349', 'Livernois, Detroit, MI, USA, 556', '', 'Detroit', 'MI', NULL, 'dew', NULL, '2025-07-26 02:52:43', '2025-07-26 19:48:44'),
(44, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.com', '2483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA, 22', '', 'Bloomfield Hills', 'MI', '48301', 'notes', 'archived', '2025-07-26 17:17:32', '2025-07-27 00:00:33'),
(45, 7, 'Joshua', '', 'joshuakelment@gmail.com', '9446178923', 'Chelsea Piers, New York, NY, USA, 442', '', 'New York', 'NY', '10011', NULL, 'archived', '2025-07-26 20:14:06', '2025-07-26 21:31:06'),
(46, 7, 'Dave', '', 'davidson@gmail.com', '9556791130', 'Chelsea Piers, New York, NY, USA, 334', '', 'New York', 'NY', '10011', NULL, 'archived', '2025-07-26 20:18:23', '2025-07-26 20:58:24'),
(47, 7, 'Silva Gareth', '', 'silvagareth49@gmail.com', '9440168432', 'Chelsea Street, Boston, MA, USA, 205', '', 'Boston', 'MA', NULL, NULL, NULL, '2025-07-26 20:56:21', '2025-07-26 21:30:56'),
(48, 7, 'John Bull', '', 'johnbull119@gmail.com', '9447120032', 'Chelsea Street, El Paso, TX, USA', '433', 'El Paso', 'TX', NULL, NULL, NULL, '2025-07-26 21:31:47', '2025-07-28 00:13:14'),
(49, 8, 'Jerome Mercy', '', 'jj@gmail.com', '6464976494', 'Machado Lane, Oakley, CA, USA, 678', '', 'Oakley', 'CA', '94561', NULL, 'archived', '2025-07-26 22:01:52', '2025-07-26 22:02:17'),
(50, 8, 'Jerome mercy', '', 'jj@gmail.com', '3333333333', 'Zwahlen Road, McConnelsville, OH, USA, 667', '', NULL, 'OH', '43756', NULL, 'active', '2025-07-26 22:03:07', '2025-07-26 22:03:07'),
(51, 5, 'Georgiy Sayapin 3', '', 'sayapingeorge@gmail.com', '2483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA, 22', '', 'Bloomfield Hills', 'MI', '48301', '22222', 'active', '2025-07-27 00:01:12', '2025-07-27 00:01:12'),
(52, 5, 'Test 3333', '', 'info@spotless.homes', '2483462681', '2356 Merrell Road, Dallas, TX, USA', '22', 'Dallas', 'TX', '75229', 'description', NULL, '2025-07-27 00:02:47', '2025-08-11 14:50:55'),
(53, 9, 'youo56', '', 'yuyuy@gmail.com', '8887878787', 'Manchester Expressway, Columbus, GA, USA', '8989', 'Los Angeles', 'CA', NULL, NULL, 'archived', '2025-07-27 13:12:57', '2025-07-27 13:14:44'),
(54, 9, 'opopo', '', 'ui@gmail.com', '6767676767', 'John Ireton Road, Winfield, KS, USA', '009', NULL, 'KS', '67156', NULL, 'archived', '2025-07-27 13:16:07', '2025-07-27 13:17:23'),
(55, 9, 'uiuiuiu', '', '6t6@gmail.com', '8989898998', '3434 West Illinois Avenue, Dallas, TX, USA', '667', 'Dallas', 'TX', '75211', NULL, NULL, '2025-07-27 13:19:11', '2025-07-27 13:19:54'),
(56, 7, 'Milli Joshua', '', 'joshua@now2code.com', '2349030844', '7 Meriden Street, Rochester, NY, USA', '676', 'Rochester', 'NY', '14612', NULL, 'archived', '2025-07-27 13:43:57', '2025-07-27 13:48:38'),
(57, 5, 'Georgiy Sayapin 34', '', 'sayapingeorge@gmail.com', '+12483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA', '22', 'Bloomfield Hills', 'MI', '48301', 'dsfaadsf', 'active', '2025-07-27 19:04:32', '2025-07-27 19:04:32'),
(58, 3, 'Adeniyi Adejuwon', '', 'adeniyiadejuwon0@gmail.com', '+2348107370125', 'Chelsea Avenue, Memphis, TN, USA', '32', 'Memphis', 'TN', NULL, NULL, 'active', '2025-08-04 15:22:29', '2025-08-04 15:22:29'),
(59, 3, 'Belu benson', '', 'ajajaolamilekan70@gmail.com', '9882017765', 'Devries Rd, Lodi, CA, USA', '33', 'Lodi', 'CA', '95242', NULL, 'active', '2025-08-04 15:26:13', '2025-08-04 15:26:13'),
(60, 10, 'j.j', '', 'eeee@gmail.com', '4353434534', 'Feamster Farm Lane, Lewisburg, WV, USA', '35356', NULL, 'WV', '24901', NULL, 'active', '2025-08-06 14:30:52', '2025-08-06 14:30:52'),
(61, 3, 'Adeniyi', '', 'adeniyiadejuwon0@gmail.com', '9445286723', 'Chelsea Avenue, Memphis, TN, USA', '500', 'Memphis', 'TN', NULL, NULL, 'active', '2025-08-06 16:25:39', '2025-08-06 16:25:39'),
(62, 5, 'Georgiy Sayapin 33', '', 'sayapingeorge@gmail.com', '+12483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA', '322', 'Bloomfield Hills', 'MI', '48301', NULL, 'archived', '2025-08-06 18:25:41', '2025-08-11 14:49:55'),
(63, 3, 'Adeniyi Adejuwon', '', 'adeniyiadejuwon05@gmail.com', '+2348107370125', 'Cherohala Skyway, Robbinsville, NC, USA', NULL, 'Robbinsville', 'NC', NULL, NULL, 'active', '2025-08-08 09:28:00', '2025-08-08 09:28:00'),
(64, 3, 'Adeniyi Adejuwon', '', 'adeniyiadejuwon055@gmail.com', '8107370125', 'Chelton Loop North, Colorado Springs, CO, USA', NULL, 'Colorado Springs', 'CO', '80909', NULL, 'active', '2025-08-08 09:28:41', '2025-08-08 09:28:41'),
(65, 3, 'Adeniyi Adejuwon', '', 'adeniyiadejuwon0589@gmail.com', '8107370125', 'North Chelton Road, Colorado Springs, CO, USA', NULL, 'Colorado Springs', 'CO', '80909', NULL, 'active', '2025-08-08 11:20:23', '2025-08-08 11:20:23'),
(66, 3, 'Adeniyi Adejuwon', '', 'adeniyiadejuwon05@gmail.com', '8107370125', 'Chelhar Lane, Channing, MI, USA', NULL, NULL, 'MI', '49815', NULL, 'active', '2025-08-08 11:34:07', '2025-08-08 11:34:07'),
(67, 5, 'Test customer', '', 'sayapingeorge@gmail.com', '+12483462681', '12001 Dr M.L.K. Jr St, Homer, LA, USA', NULL, 'Homer', 'LA', '71040', NULL, 'archived', '2025-08-08 17:56:24', '2025-08-11 14:51:08'),
(68, 5, 'Georgiy Sayapin testing August 11', '', 'sayapingeorge@gmail.com', '+12483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA', '22', 'Bloomfield Hills', 'MI', '48301', 'asfdsadf', 'archived', '2025-08-11 14:49:21', '2025-08-11 14:49:46'),
(69, 5, 'Georgiy Sayapin ads', '', 'sayapingeorge@gmail.com', '+12483462681', '5631 Raven Ct, Bloomfield Hills, MI, USA', 'a', 'Bloomfield Hills', 'MI', '48301', 'adfs', 'archived', '2025-08-11 21:47:50', '2025-08-11 21:48:37'),
(70, 5, 'Georgiy Sayapin dsaf', '', 'sayapingeorge@gmail.com', '+12483462681', '5631 Mc Raven Court, New Orleans, LA, USA', NULL, 'New Orleans', 'LA', '70128', NULL, 'archived', '2025-08-11 21:49:39', '2025-08-11 21:49:47'),
(71, 5, 'Georgiy Sayapin', '', NULL, '+12483462681', '5631 Raven Ct, Brookfield, WI, USA', NULL, 'Brookfield', 'WI', '53005', NULL, 'active', '2025-08-11 22:03:50', '2025-08-11 22:03:50'),
(72, 5, 'Georgiy Sayapin', '', 'sayapingeorge@gmail.com', '+12483462681', '5631 Raven Ct, Shelbyville, KY, USA', NULL, 'Shelbyville', 'KY', '40065', NULL, 'active', '2025-08-11 22:21:14', '2025-08-11 22:21:14'),
(73, 3, 'Dev', 'Hub', 'devhub@gmail.com', '+2348107370125', '6 opposite school gate, iworoko rd', '22', NULL, NULL, NULL, 'Goodsiyfgbijh', NULL, '2025-08-14 01:12:08', '2025-08-15 22:54:18'),
(74, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.co', '+12483462681', '5631 Raven Ct.', NULL, NULL, NULL, NULL, NULL, 'archived', '2025-08-14 13:15:26', '2025-08-14 13:15:37'),
(75, 5, 'GeorgiyEdited', 'Sayapin', 'sayapingeorge@gmail.com', '+12483462681', '5631 Raven Ct.', NULL, NULL, NULL, NULL, NULL, NULL, '2025-08-14 13:16:25', '2025-08-17 19:35:01'),
(76, 3, 'OLAMILEKAN', 'AJAJA', 'ajajaolamilekan7@gmail.com', '+2349030844572', '146 NITEL JUNCTION 146 Nitel Junction State', NULL, NULL, NULL, NULL, NULL, 'active', '2025-08-18 16:29:30', '2025-08-18 16:29:30'),
(77, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon077@gmail.com', '+2348107370125', '6 opposite school gate, iworoko rd, osekita', NULL, NULL, NULL, NULL, NULL, 'active', '2025-08-22 18:25:39', '2025-08-22 18:25:39'),
(78, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon05@gmail.com', '+2348107370125', 'Chelton Road, Colorado Springs, CO, USA', NULL, NULL, NULL, NULL, NULL, 'active', '2025-08-22 18:46:02', '2025-08-22 18:46:02');

-- --------------------------------------------------------

--
-- Table structure for table `customer_notifications`
--

CREATE TABLE `customer_notifications` (
  `id` int NOT NULL,
  `customer_id` int NOT NULL,
  `job_id` int DEFAULT NULL,
  `type` enum('email','sms') COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('pending','sent','failed') COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `sent_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `customer_notification_preferences`
--

CREATE TABLE `customer_notification_preferences` (
  `id` int NOT NULL,
  `customer_id` int NOT NULL,
  `email_notifications` tinyint(1) DEFAULT '0',
  `sms_notifications` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `customer_notification_preferences`
--

INSERT INTO `customer_notification_preferences` (`id`, `customer_id`, `email_notifications`, `sms_notifications`, `created_at`, `updated_at`) VALUES
(1, 42, 1, 0, '2025-07-31 21:58:39', '2025-07-31 22:01:04'),
(2, 40, 1, 0, '2025-08-01 00:19:02', '2025-08-08 09:10:31'),
(3, 38, NULL, NULL, '2025-08-05 18:37:18', '2025-08-05 18:37:18'),
(4, 21, NULL, NULL, '2025-08-06 16:19:12', '2025-08-06 16:19:12'),
(5, 59, NULL, NULL, '2025-08-07 18:13:37', '2025-08-07 18:35:59'),
(6, 65, 1, 1, '2025-08-08 11:22:49', '2025-08-08 11:22:49'),
(7, 66, 1, 1, '2025-08-08 11:36:16', '2025-08-08 11:36:16');

-- --------------------------------------------------------

--
-- Table structure for table `custom_payment_methods`
--

CREATE TABLE `custom_payment_methods` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `custom_payment_methods`
--

INSERT INTO `custom_payment_methods` (`id`, `user_id`, `name`, `description`, `is_active`, `created_at`, `updated_at`) VALUES
(1, 3, 'Cash', 'Pay with cash upon service completion', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(2, 3, 'Check', 'Pay with check mailed to business address', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(3, 2, 'Cash', 'Pay with cash upon service completion', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(4, 2, 'Check', 'Pay with check mailed to business address', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(5, 1, 'Cash', 'Pay with cash upon service completion', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(6, 1, 'Check', 'Pay with check mailed to business address', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(7, 4, 'Cash', 'Pay with cash upon service completion', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46'),
(8, 4, 'Check', 'Pay with check mailed to business address', 1, '2025-07-16 02:17:46', '2025-07-16 02:17:46');

-- --------------------------------------------------------

--
-- Table structure for table `estimates`
--

CREATE TABLE `estimates` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `customer_id` int NOT NULL,
  `services` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `total_amount` decimal(10,2) NOT NULL,
  `status` enum('pending','sent','accepted','rejected') COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `valid_until` date DEFAULT NULL,
  `notes` text COLLATE utf8mb4_general_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

--
-- Dumping data for table `estimates`
--

INSERT INTO `estimates` (`id`, `user_id`, `customer_id`, `services`, `total_amount`, `status`, `valid_until`, `notes`, `created_at`, `updated_at`) VALUES
(1, 3, 1, '[{\"serviceId\":1,\"name\":\"Home Cleaning\",\"price\":\"100.00\",\"quantity\":1,\"description\":\"Sample service\"}]', 100.00, 'sent', '2025-08-17', 'Sample estimate for testing', '2025-07-18 11:45:52', '2025-07-19 00:10:54'),
(2, 3, 1, '[{\"serviceId\":1,\"name\":\"Home Cleaning\",\"price\":\"100.00\",\"quantity\":2,\"description\":\"Sample service\"}]', 200.00, 'sent', '2025-08-02', 'Second sample estimate', '2025-07-18 11:45:52', '2025-07-24 06:39:41'),
(3, 3, 1, '[{\"serviceId\":1,\"name\":\"Home Cleaning\",\"price\":\"100.00\",\"quantity\":3,\"description\":\"Sample service\"}]', 300.00, 'accepted', '2025-07-25', 'Accepted estimate', '2025-07-18 11:45:52', '2025-07-19 00:42:24');

-- --------------------------------------------------------

--
-- Table structure for table `invoices`
--

CREATE TABLE `invoices` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `customer_id` int NOT NULL,
  `job_id` int DEFAULT NULL,
  `estimate_id` int DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `tax_amount` decimal(10,2) DEFAULT '0.00',
  `total_amount` decimal(10,2) NOT NULL,
  `status` enum('draft','sent','paid','overdue','cancelled') DEFAULT 'draft',
  `due_date` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `invoices`
--

INSERT INTO `invoices` (`id`, `user_id`, `customer_id`, `job_id`, `estimate_id`, `amount`, `tax_amount`, `total_amount`, `status`, `due_date`, `created_at`, `updated_at`) VALUES
(1, 3, 42, NULL, NULL, 95.00, 0.00, 95.00, 'sent', NULL, '2025-07-31 21:10:00', '2025-07-31 21:10:00'),
(2, 3, 42, NULL, NULL, 95.00, 0.00, 95.00, 'sent', NULL, '2025-07-31 21:10:33', '2025-07-31 21:10:33'),
(3, 3, 42, NULL, NULL, 95.00, 0.00, 95.00, 'sent', NULL, '2025-08-01 00:10:30', '2025-08-01 00:10:30'),
(4, 3, 42, NULL, NULL, 95.00, 0.00, 95.00, 'sent', NULL, '2025-08-01 00:10:44', '2025-08-01 00:10:44'),
(5, 3, 42, NULL, NULL, 95.00, 0.00, 95.00, 'sent', NULL, '2025-08-01 00:13:53', '2025-08-01 00:13:53'),
(6, 3, 40, NULL, NULL, 95.00, 0.00, 95.00, 'paid', NULL, '2025-08-01 00:19:12', '2025-08-01 00:20:12'),
(8, 3, 38, NULL, NULL, 95.00, 0.00, 95.00, 'sent', NULL, '2025-08-01 18:53:57', '2025-08-01 18:53:57'),
(9, 3, 40, NULL, NULL, 120.00, 0.00, 120.00, 'sent', NULL, '2025-08-02 23:27:19', '2025-08-02 23:27:19');

-- --------------------------------------------------------

--
-- Table structure for table `jobs`
--

CREATE TABLE `jobs` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `customer_id` int NOT NULL,
  `service_id` int DEFAULT NULL,
  `team_member_id` int DEFAULT NULL,
  `territory_id` int DEFAULT NULL,
  `scheduled_date` datetime NOT NULL,
  `notes` text COLLATE utf8mb4_general_ci,
  `status` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `invoice_status` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `invoice_id` int DEFAULT NULL,
  `invoice_amount` decimal(10,2) DEFAULT NULL,
  `invoice_date` date DEFAULT NULL,
  `payment_date` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_recurring` tinyint(1) DEFAULT '0' COMMENT 'Whether this job is recurring',
  `recurring_frequency` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `next_billing_date` date DEFAULT NULL COMMENT 'Next billing date for recurring jobs',
  `stripe_payment_intent_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Stripe payment intent ID',
  `duration` int DEFAULT '360' COMMENT 'Duration in minutes',
  `workers` int DEFAULT '1' COMMENT 'Number of workers needed',
  `skills_required` int DEFAULT '0' COMMENT 'Number of skills required',
  `price` decimal(10,2) DEFAULT '0.00' COMMENT 'Job price',
  `discount` decimal(10,2) DEFAULT '0.00' COMMENT 'Discount amount',
  `additional_fees` decimal(10,2) DEFAULT '0.00' COMMENT 'Additional fees',
  `taxes` decimal(10,2) DEFAULT '0.00' COMMENT 'Tax amount',
  `total` decimal(10,2) DEFAULT '0.00' COMMENT 'Total amount',
  `payment_method` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Payment method',
  `territory` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Territory name',
  `schedule_type` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `let_customer_schedule` tinyint(1) DEFAULT '0' COMMENT 'Let customer schedule',
  `offer_to_providers` tinyint(1) DEFAULT '0' COMMENT 'Offer to service providers',
  `internal_notes` text COLLATE utf8mb4_general_ci COMMENT 'Internal notes',
  `contact_info` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Contact information JSON',
  `customer_notes` text COLLATE utf8mb4_general_ci COMMENT 'Notes visible to customer',
  `scheduled_time` time DEFAULT '09:00:00' COMMENT 'Scheduled time',
  `service_address_street` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Service address street',
  `service_address_city` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Service address city',
  `service_address_state` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Service address state',
  `service_address_zip` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Service address zip code',
  `service_address_country` varchar(100) COLLATE utf8mb4_general_ci DEFAULT 'USA' COMMENT 'Service address country',
  `service_address_lat` decimal(10,8) DEFAULT NULL COMMENT 'Service address latitude',
  `service_address_lng` decimal(11,8) DEFAULT NULL COMMENT 'Service address longitude',
  `service_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Service name (cached from services table)',
  `bathroom_count` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Bathroom details/count',
  `workers_needed` int DEFAULT '1' COMMENT 'Number of workers needed',
  `skills` json DEFAULT NULL COMMENT 'Required skills as JSON array',
  `service_price` decimal(10,2) DEFAULT '0.00' COMMENT 'Service price',
  `total_amount` decimal(10,2) DEFAULT '0.00' COMMENT 'Total amount',
  `estimated_duration` int DEFAULT NULL,
  `special_instructions` text COLLATE utf8mb4_general_ci,
  `payment_status` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `priority` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `quality_check` tinyint(1) DEFAULT '1',
  `photos_required` tinyint(1) DEFAULT '0',
  `customer_signature` tinyint(1) DEFAULT '0',
  `auto_invoice` tinyint(1) DEFAULT '1',
  `auto_reminders` tinyint(1) DEFAULT '1',
  `recurring_end_date` date DEFAULT NULL,
  `tags` json DEFAULT NULL,
  `intake_question_answers` json DEFAULT NULL,
  `service_modifiers` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Service modifiers (JSON)',
  `service_intake_questions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Service intake questions (JSON)'
) ;

--
-- Dumping data for table `jobs`
--

INSERT INTO `jobs` (`id`, `user_id`, `customer_id`, `service_id`, `team_member_id`, `territory_id`, `scheduled_date`, `notes`, `status`, `invoice_status`, `invoice_id`, `invoice_amount`, `invoice_date`, `payment_date`, `created_at`, `updated_at`, `is_recurring`, `recurring_frequency`, `next_billing_date`, `stripe_payment_intent_id`, `duration`, `workers`, `skills_required`, `price`, `discount`, `additional_fees`, `taxes`, `total`, `payment_method`, `territory`, `schedule_type`, `let_customer_schedule`, `offer_to_providers`, `internal_notes`, `contact_info`, `customer_notes`, `scheduled_time`, `service_address_street`, `service_address_city`, `service_address_state`, `service_address_zip`, `service_address_country`, `service_address_lat`, `service_address_lng`, `service_name`, `bathroom_count`, `workers_needed`, `skills`, `service_price`, `total_amount`, `estimated_duration`, `special_instructions`, `payment_status`, `priority`, `quality_check`, `photos_required`, `customer_signature`, `auto_invoice`, `auto_reminders`, `recurring_end_date`, `tags`, `intake_question_answers`, `service_modifiers`, `service_intake_questions`) VALUES
(64, 5, 72, 35, NULL, NULL, '2025-08-28 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-14 14:27:54', '2025-08-14 14:27:54', 0, 'weekly', NULL, NULL, 360, 1, 0, 120.00, 0.00, 0.00, 0.00, 120.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct, Shelbyville, KY, USA', 'Shelbyville', 'KY', '40065', 'USA', NULL, NULL, 'Regular cleaning', NULL, 1, NULL, 120.00, 120.00, 30, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(65, 5, 72, 35, NULL, NULL, '2025-08-14 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-14 14:28:45', '2025-08-14 14:28:45', 0, 'weekly', NULL, NULL, 360, 1, 0, 120.00, 0.00, 0.00, 0.00, 120.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '02:00:00', '5631 Raven Ct, Shelbyville, KY, USA', 'Shelbyville', 'KY', '40065', 'USA', NULL, NULL, 'Regular cleaning', NULL, 1, NULL, 120.00, 120.00, 30, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(66, 3, 73, 37, 16, 5, '2025-08-16 00:00:00', NULL, 'cancelled', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 02:18:52', '2025-08-23 16:44:46', 0, 'weekly', NULL, NULL, 300, 1, 0, 265.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"+2348107370125\",\"email\":\"devhub@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '6 opposite school gate', 'iworoko rd', NULL, NULL, 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 265.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(67, 3, 73, 37, 10, 1, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 02:30:26', '2025-08-16 02:30:26', 0, 'weekly', NULL, NULL, 300, 1, 0, 265.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Just web', 'one-time', 0, 0, NULL, '{\"phone\":\"+2348107370125\",\"email\":\"devhub@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '6 opposite school gate', 'iworoko rd', NULL, NULL, 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 265.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(68, 3, 73, 37, 10, 1, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 03:02:37', '2025-08-16 03:02:37', 0, 'weekly', NULL, NULL, 420, 1, 0, 280.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Just web', 'one-time', 0, 0, NULL, '{\"phone\":\"+2348107370125\",\"email\":\"devhub@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '6 opposite school gate', 'iworoko rd', NULL, NULL, 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 280.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(69, 3, 65, 37, 11, 5, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 03:14:52', '2025-08-16 03:14:52', 0, 'weekly', NULL, NULL, 300, 1, 0, 265.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"8107370125\",\"email\":\"adeniyiadejuwon0589@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'North Chelton Road, Colorado Springs, CO, USA', 'Colorado Springs', 'CO', '80909', 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 265.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(70, 3, 64, 37, 11, 5, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 03:24:26', '2025-08-16 03:24:26', 0, 'weekly', NULL, NULL, 420, 1, 0, 280.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"8107370125\",\"email\":\"adeniyiadejuwon055@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'Chelton Loop North, Colorado Springs, CO, USA', 'Colorado Springs', 'CO', '80909', 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 280.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(71, 3, 66, 37, 12, 5, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 03:47:04', '2025-08-16 03:47:04', 0, 'weekly', NULL, NULL, 300, 1, 0, 265.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"8107370125\",\"email\":\"adeniyiadejuwon05@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'Chelhar Lane', 'Channing', 'MI', NULL, 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 265.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(72, 3, 43, 37, 11, 1, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 04:01:27', '2025-08-16 04:01:27', 0, 'weekly', NULL, NULL, 300, 1, 0, 265.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Just web', 'one-time', 0, 0, NULL, '{\"phone\":\"9017393349\",\"email\":\"adeniyiadejuwonoo@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'Livernois', 'Detroit', 'MI', NULL, 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 265.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(73, 3, 59, 37, 12, 5, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 20:32:42', '2025-08-16 21:10:49', 0, 'weekly', NULL, NULL, 480, 1, 0, 295.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"9882017765\",\"email\":\"ajajaolamilekan70@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'Devries Rd, Lodi, CA, USA', 'Lodi', 'CA', '95242', 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 295.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(74, 3, 65, 39, 12, 1, '2025-08-16 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 21:24:01', '2025-08-16 21:24:44', 0, 'weekly', NULL, NULL, 180, 1, 0, 155.00, 0.00, 0.00, 0.00, 125.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"8107370125\",\"email\":\"adeniyiadejuwon0589@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'North Chelton Road, Colorado Springs, CO, USA', 'Colorado Springs', 'CO', '80909', 'USA', NULL, NULL, 'HVAC Service', NULL, 1, NULL, 155.00, 125.00, 120, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(75, 3, 61, 39, 12, 1, '2025-08-18 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-16 21:31:42', '2025-08-16 21:31:42', 0, 'weekly', NULL, NULL, 120, 1, 0, 145.00, 0.00, 0.00, 0.00, 125.00, NULL, 'Just web', 'one-time', 0, 0, NULL, '{\"phone\":\"9445286723\",\"email\":\"adeniyiadejuwon0@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '23:00:00', 'Chelsea Avenue', 'Memphis', 'TN', NULL, 'USA', NULL, NULL, 'HVAC Service', NULL, 1, NULL, 145.00, 125.00, 120, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(76, 5, 75, 35, NULL, NULL, '2025-08-18 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-18 15:03:45', '2025-08-18 15:03:45', 0, 'weekly', NULL, NULL, 120, 1, 0, 220.00, 0.00, 0.00, 0.00, 120.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct.', NULL, NULL, NULL, 'USA', NULL, NULL, 'Regular cleaning', NULL, 1, NULL, 220.00, 120.00, 30, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(77, 3, 66, 37, 11, 1, '2025-08-19 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-18 16:35:31', '2025-08-18 16:35:31', 0, 'weekly', NULL, NULL, 480, 1, 0, 295.00, 0.00, 0.00, 0.00, 250.00, NULL, 'Just web', 'one-time', 0, 0, NULL, '{\"phone\":\"8107370125\",\"email\":\"adeniyiadejuwon05@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', 'Chelhar Lane', 'Channing', 'MI', NULL, 'USA', NULL, NULL, 'Moving Service', NULL, 1, NULL, 295.00, 250.00, 240, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(78, 5, 75, 45, NULL, NULL, '2025-08-18 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-18 23:06:20', '2025-08-18 23:06:20', 0, 'weekly', NULL, NULL, 180, 1, 0, 162.98, 0.00, 0.00, 0.00, 99.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct.', NULL, NULL, NULL, 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 162.98, 99.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(79, 5, 75, 45, NULL, NULL, '2025-08-19 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-19 18:21:32', '2025-08-19 18:21:32', 0, 'weekly', NULL, NULL, 120, 1, 0, 152.98, 0.00, 0.00, 0.00, 99.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct.', NULL, NULL, NULL, 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 152.98, 99.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(80, 3, 73, 38, 11, 5, '2025-08-20 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-20 20:38:01', '2025-08-20 20:38:01', 0, 'weekly', NULL, NULL, 240, 1, 0, 75.00, 0.00, 0.00, 0.00, 40.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"+2348107370125\",\"email\":\"devhub@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '6 opposite school gate', 'iworoko rd', NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 75.00, 40.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(81, 3, 66, 44, 11, 1, '2025-08-20 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-20 20:41:14', '2025-08-20 20:41:14', 0, 'weekly', NULL, NULL, 60, 1, 0, 80.00, 0.00, 0.00, 0.00, 80.00, NULL, 'Just web', 'one-time', 0, 0, NULL, '{\"phone\":\"8107370125\",\"email\":\"adeniyiadejuwon05@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '10:00:00', 'Chelhar Lane', 'Channing', 'MI', NULL, 'USA', NULL, NULL, 'Driving', NULL, 1, NULL, 80.00, 80.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(82, 3, 76, 38, 13, 5, '2025-08-21 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 07:03:37', '2025-08-21 07:03:37', 0, 'weekly', NULL, NULL, 300, 1, 0, 80.00, 0.00, 0.00, 0.00, 40.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"+2349030844572\",\"email\":\"ajajaolamilekan7@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '146 NITEL JUNCTION 146 Nitel Junction State', NULL, NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 80.00, 40.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(83, 3, 38, 38, NULL, NULL, '2025-08-21 10:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 07:50:13', '2025-08-21 07:50:13', 0, 'weekly', NULL, NULL, 120, 1, 0, 55.00, 0.00, 0.00, 0.00, 40.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"9445329907\",\"email\":\"devwev@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '10:00:00', 'Plantation Palms Blvd, Land O&#x27; Lakes, FL, USA, 554', 'Land O&#x27; Lakes', 'FL', '34639', 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 40.00, 40.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(84, 3, 14, 38, NULL, NULL, '2025-08-21 10:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 08:11:38', '2025-08-21 08:11:38', 0, 'weekly', NULL, NULL, 120, 1, 0, 55.00, 0.00, 0.00, 0.00, 40.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"08107470125\",\"email\":\"adeniyiadejuwon0@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '10:00:00', '27', 'streeet', NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 40.00, 40.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(85, 3, 73, 38, NULL, NULL, '2025-08-21 09:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 08:23:53', '2025-08-21 08:23:53', 0, 'weekly', NULL, NULL, 120, 1, 0, 55.00, 0.00, 0.00, 0.00, 40.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+2348107370125\",\"email\":\"devhub@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '6 opposite school gate', 'iworoko rd', NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 40.00, 40.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(86, 3, 73, 38, NULL, NULL, '2025-08-21 10:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 12:00:21', '2025-08-21 12:00:21', 0, 'weekly', NULL, NULL, 120, 1, 0, 55.00, 0.00, 0.00, 0.00, 55.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+2348107370125\",\"email\":\"devhub@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '10:00:00', '6 opposite school gate', 'iworoko rd', NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 55.00, 55.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(87, 3, 3, 38, 12, NULL, '2025-08-21 10:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 12:05:55', '2025-08-21 12:06:49', 0, 'weekly', NULL, NULL, 150, 1, 0, 55.00, 0.00, 0.00, 0.00, 55.00, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+1987654321\",\"email\":\"jane.smith@email.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '10:00:00', '456 Oak Avenue', NULL, NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 55.00, 55.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(88, 3, 3, 38, 11, 5, '2025-08-21 11:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 12:58:19', '2025-08-21 12:58:19', 0, 'weekly', NULL, NULL, 150, 1, 0, 55.00, 0.00, 0.00, 0.00, 55.00, NULL, 'Bedbug', 'one-time', 0, 0, NULL, '{\"phone\":\"+1987654321\",\"email\":\"jane.smith@email.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '11:00:00', '456 Oak Avenue', NULL, NULL, NULL, 'USA', NULL, NULL, 'Beat cows', NULL, 1, NULL, 55.00, 55.00, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(89, 5, 57, 57, 6, 4, '2025-08-21 09:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 20:32:59', '2025-08-21 20:32:59', 0, 'weekly', NULL, NULL, 38, 2, 0, 18.00, 0.00, 0.00, 0.00, 18.00, NULL, 'St Petersburg', 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct, Bloomfield Hills, MI, USA', 'Bloomfield Hills', 'MI', '48301', 'USA', NULL, NULL, 'Price testing service', NULL, 2, NULL, 18.00, 18.00, 30, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(90, 5, 72, 45, NULL, NULL, '2025-08-21 09:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-21 20:33:56', '2025-08-21 20:33:56', 0, 'weekly', NULL, NULL, 150, 1, 0, 132.98, 0.00, 0.00, 0.00, 132.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct, Shelbyville, KY, USA', 'Shelbyville', 'KY', '40065', 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 132.98, 132.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(91, 5, 75, 45, NULL, NULL, '2025-08-21 09:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-22 00:04:35', '2025-08-22 00:04:35', 0, 'weekly', NULL, NULL, 170, 1, 0, 152.98, 0.00, 0.00, 0.00, 152.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct.', NULL, NULL, NULL, 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 152.98, 152.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(92, 5, 75, 45, 9, NULL, '2025-08-22 09:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-22 11:31:43', '2025-08-22 11:31:43', 0, 'weekly', NULL, NULL, 180, 1, 0, 162.98, 0.00, 0.00, 0.00, 162.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '09:00:00', '5631 Raven Ct.', NULL, NULL, NULL, 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 162.98, 162.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(93, 5, 75, 45, NULL, NULL, '2025-08-19 00:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-22 11:40:06', '2025-08-22 11:40:06', 0, 'weekly', NULL, NULL, 100, 1, 0, 109.98, 0.00, 0.00, 0.00, 109.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '00:00:00', '5631 Raven Ct.', NULL, NULL, NULL, 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 109.98, 109.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(94, 5, 72, 45, NULL, NULL, '2025-08-29 10:00:00', NULL, 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-22 11:41:36', '2025-08-22 11:41:36', 0, 'weekly', NULL, NULL, 150, 1, 0, 132.98, 0.00, 0.00, 0.00, 132.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '10:00:00', '5631 Raven Ct, Shelbyville, KY, USA', 'Shelbyville', 'KY', '40065', 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 132.98, 132.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(95, 5, 72, 45, NULL, NULL, '2025-08-20 01:00:00', NULL, 'confirmed', 'draft', NULL, NULL, NULL, NULL, '2025-08-22 11:42:56', '2025-08-22 11:44:35', 0, 'weekly', NULL, NULL, 134, 1, 0, 143.98, 0.00, 0.00, 0.00, 143.98, NULL, NULL, 'one-time', 0, 0, NULL, '{\"phone\":\"+12483462681\",\"email\":\"sayapingeorge@gmail.com\",\"emailNotifications\":true,\"textNotifications\":false}', NULL, '01:00:00', '5631 Raven Ct, Shelbyville, KY, USA', 'Shelbyville', 'KY', '40065', 'USA', NULL, NULL, 'Freon adding', NULL, 1, NULL, 143.98, 143.98, 90, NULL, 'pending', 'normal', 1, 0, 0, 1, 1, NULL, NULL, NULL, NULL, NULL),
(96, 3, 73, 38, 13, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 13:24:41', '2025-08-23 16:19:23', 0, NULL, NULL, NULL, 450, 1, 0, 110.00, 0.00, 0.00, 0.00, 110.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Beat cows', NULL, 0, '[]', 0.00, 0.00, 450, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755595518071,\"title\":\"will you eat?\",\"description\":\"eating\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":15,\"totalDuration\":60}],\"totalModifierPrice\":15,\"totalModifierDuration\":60},{\"id\":1755689702257,\"title\":\"Buybit clause?\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":120,\"description\":\"4 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":20,\"totalDuration\":120}],\"totalModifierPrice\":20,\"totalModifierDuration\":120}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"yes\",\"image\":\"\"},{\"id\":2,\"text\":\"No\",\"image\":\"\"},{\"id\":3,\"text\":\"of course\",\"image\":\"\"},{\"id\":4,\"text\":\"I won\'t\",\"image\":\"\"}],\"question\":\"will you drop me?\",\"required\":false,\"description\":\"\",\"questionType\":\"dropdown\",\"selectionType\":\"multi\",\"answer\":[\"No\",\"of course\"]},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"option 1\",\"image\":\"\"},{\"id\":2,\"text\":\"option 2\",\"image\":\"\"}],\"question\":\"Select 234\",\"required\":false,\"description\":\"\",\"questionType\":\"dropdown\",\"selectionType\":\"multi\",\"answer\":[\"option 1\",\"option 2\"]},{\"id\":3,\"questionType\":\"dropdown\",\"question\":\"Best des\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"text\":\"opti 1\"}],\"answer\":\"opti 1\"}]'),
(97, 3, 76, 38, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 13:25:41', '2025-08-23 13:25:41', 0, NULL, NULL, NULL, 450, 1, 0, 110.00, 0.00, 0.00, 0.00, 110.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '146 NITEL JUNCTION 146 Nitel Junction State', '', '', '', 'USA', NULL, NULL, 'Beat cows', NULL, 0, '[]', 0.00, 0.00, 450, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755595518071,\"title\":\"will you eat?\",\"description\":\"eating\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":15,\"totalDuration\":60}],\"totalModifierPrice\":15,\"totalModifierDuration\":60},{\"id\":1755689702257,\"title\":\"Buybit clause?\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":120,\"description\":\"4 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":20,\"totalDuration\":120}],\"totalModifierPrice\":20,\"totalModifierDuration\":120}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"yes\",\"image\":\"\"},{\"id\":2,\"text\":\"No\",\"image\":\"\"},{\"id\":3,\"text\":\"of course\",\"image\":\"\"},{\"id\":4,\"text\":\"I won\'t\",\"image\":\"\"}],\"question\":\"will you drop me?\",\"required\":false,\"description\":\"\",\"questionType\":\"dropdown\",\"selectionType\":\"multi\",\"answer\":[\"of course\",\"I won\'t\"]},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"option 1\",\"image\":\"\"},{\"id\":2,\"text\":\"option 2\",\"image\":\"\"}],\"question\":\"Select 234\",\"required\":false,\"description\":\"\",\"questionType\":\"dropdown\",\"selectionType\":\"multi\",\"answer\":[\"option 1\"]},{\"id\":3,\"questionType\":\"dropdown\",\"question\":\"Best des\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"text\":\"opti 1\"}],\"answer\":\"opti 1\"}]'),
(98, 3, 76, 37, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 13:33:48', '2025-08-23 13:33:48', 0, NULL, NULL, NULL, 600, 1, 0, 310.00, 0.00, 0.00, 0.00, 310.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '146 NITEL JUNCTION 146 Nitel Junction State', '', '', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 600, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":30,\"totalDuration\":180}],\"totalModifierPrice\":30,\"totalModifierDuration\":180}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"\"}],\"question\":\"\",\"required\":false,\"description\":\"\",\"questionType\":\"image_upload\",\"selectionType\":\"single\",\"answer\":null},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"#3f2727\"},{\"id\":2,\"text\":\"#FFFF00\",\"image\":\"\"},{\"id\":3,\"text\":\"#32CD32\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"color_choice\",\"selectionType\":\"multi\",\"answer\":null},{\"id\":3,\"options\":[{\"id\":1,\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"},{\"id\":2,\"text\":\"\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"picture_choice\",\"selectionType\":\"single\",\"answer\":null}]'),
(99, 3, 77, 37, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 13:45:58', '2025-08-23 13:45:58', 0, NULL, NULL, NULL, 600, 1, 0, 310.00, 0.00, 0.00, 0.00, 310.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', 'osekita', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 600, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":30,\"totalDuration\":180}],\"totalModifierPrice\":30,\"totalModifierDuration\":180}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"\"}],\"question\":\"\",\"required\":false,\"description\":\"\",\"questionType\":\"image_upload\",\"selectionType\":\"single\",\"answer\":null},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"#3f2727\"},{\"id\":2,\"text\":\"#FFFF00\",\"image\":\"\"},{\"id\":3,\"text\":\"#32CD32\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"color_choice\",\"selectionType\":\"multi\",\"answer\":null},{\"id\":3,\"options\":[{\"id\":1,\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"},{\"id\":2,\"text\":\"\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"picture_choice\",\"selectionType\":\"single\",\"answer\":null}]'),
(100, 3, 73, 37, 11, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 13:51:39', '2025-08-23 13:51:39', 0, NULL, NULL, NULL, 420, 1, 0, 280.00, 0.00, 0.00, 0.00, 280.00, '', 'Bedbug', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Moving Service', NULL, 1, '[]', 0.00, 0.00, 420, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":1,\"totalPrice\":15,\"totalDuration\":90}],\"totalModifierPrice\":15,\"totalModifierDuration\":90}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"\"}],\"question\":\"\",\"required\":false,\"description\":\"\",\"questionType\":\"image_upload\",\"selectionType\":\"single\",\"answer\":null},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"#3f2727\"},{\"id\":2,\"text\":\"#FFFF00\",\"image\":\"\"},{\"id\":3,\"text\":\"#32CD32\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"color_choice\",\"selectionType\":\"multi\",\"answer\":null},{\"id\":3,\"options\":[{\"id\":1,\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"},{\"id\":2,\"text\":\"\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"picture_choice\",\"selectionType\":\"single\",\"answer\":null}]'),
(101, 3, 73, 37, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 13:58:01', '2025-08-23 13:58:01', 0, NULL, NULL, NULL, 420, 1, 0, 280.00, 0.00, 0.00, 0.00, 280.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 420, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":1,\"totalPrice\":15,\"totalDuration\":90}],\"totalModifierPrice\":15,\"totalModifierDuration\":90}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"\"}],\"question\":\"\",\"required\":false,\"description\":\"\",\"questionType\":\"image_upload\",\"selectionType\":\"single\",\"answer\":null},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"#3f2727\"},{\"id\":2,\"text\":\"#FFFF00\",\"image\":\"\"},{\"id\":3,\"text\":\"#32CD32\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"color_choice\",\"selectionType\":\"multi\",\"answer\":null},{\"id\":3,\"options\":[{\"id\":1,\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"},{\"id\":2,\"text\":\"\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"picture_choice\",\"selectionType\":\"single\",\"answer\":null}]'),
(102, 3, 63, 37, NULL, NULL, '2025-08-23 09:00:00', '', 'in-progress', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:02:30', '2025-08-23 14:02:30', 0, NULL, NULL, NULL, 600, 1, 0, 310.00, 0.00, 0.00, 0.00, 310.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Cherohala Skyway', 'Robbinsville', 'NC', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 600, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":30,\"totalDuration\":180}],\"totalModifierPrice\":30,\"totalModifierDuration\":180}]', '[{\"id\":1,\"options\":[{\"id\":1,\"text\":\"\"}],\"question\":\"\",\"required\":false,\"description\":\"\",\"questionType\":\"image_upload\",\"selectionType\":\"single\",\"answer\":null},{\"id\":2,\"options\":[{\"id\":1,\"text\":\"#3f2727\"},{\"id\":2,\"text\":\"#FFFF00\",\"image\":\"\"},{\"id\":3,\"text\":\"#32CD32\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"color_choice\",\"selectionType\":\"multi\",\"answer\":null},{\"id\":3,\"options\":[{\"id\":1,\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"},{\"id\":2,\"text\":\"\",\"image\":\"\"}],\"question\":\"Oven\",\"required\":false,\"description\":\"\",\"questionType\":\"picture_choice\",\"selectionType\":\"single\",\"answer\":null}]'),
(103, 3, 73, 37, NULL, NULL, '2025-08-24 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:17:26', '2025-08-23 14:17:26', 0, NULL, NULL, NULL, 600, 1, 0, 310.00, 0.00, 0.00, 0.00, 310.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 600, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":30,\"totalDuration\":180}],\"totalModifierPrice\":30,\"totalModifierDuration\":180}]', NULL),
(104, 3, 78, 37, NULL, NULL, '2025-08-22 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:32:56', '2025-08-23 14:32:56', 0, NULL, NULL, NULL, 600, 1, 0, 310.00, 0.00, 0.00, 0.00, 310.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Chelton Road', 'Colorado Springs', 'CO', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 600, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":30,\"totalDuration\":180}],\"totalModifierPrice\":30,\"totalModifierDuration\":180}]', NULL),
(105, 3, 59, 37, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:37:11', '2025-08-23 14:37:11', 0, NULL, NULL, NULL, 600, 1, 0, 310.00, 0.00, 0.00, 0.00, 310.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Devries Rd, Lodi, CA, USA', 'Lodi', 'CA', '95242', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 600, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":30,\"totalDuration\":180}],\"totalModifierPrice\":30,\"totalModifierDuration\":180}]', NULL),
(106, 3, 41, 37, NULL, NULL, '2025-08-30 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:42:34', '2025-08-23 14:42:34', 0, NULL, NULL, NULL, 240, 1, 0, 250.00, 0.00, 0.00, 0.00, 250.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Venice Blvd.', 'Los Angeles', 'CA', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 240, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[],\"totalModifierPrice\":0,\"totalModifierDuration\":0}]', NULL),
(107, 3, 41, 37, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:53:21', '2025-08-23 14:53:21', 0, NULL, NULL, NULL, 420, 1, 0, 280.00, 0.00, 0.00, 0.00, 280.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Venice Blvd.', 'Los Angeles', 'CA', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 420, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":1,\"totalPrice\":15,\"totalDuration\":90}],\"totalModifierPrice\":15,\"totalModifierDuration\":90}]', NULL),
(108, 3, 76, 38, NULL, NULL, '2025-08-23 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 14:54:42', '2025-08-23 14:54:42', 0, NULL, NULL, NULL, 450, 1, 0, 110.00, 0.00, 0.00, 0.00, 110.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '146 NITEL JUNCTION 146 Nitel Junction State', '', '', '', 'USA', NULL, NULL, 'Beat cows', NULL, 0, '[]', 0.00, 0.00, 450, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755595518071,\"title\":\"will you eat?\",\"description\":\"eating\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":15,\"totalDuration\":60}],\"totalModifierPrice\":15,\"totalModifierDuration\":60},{\"id\":1755689702257,\"title\":\"Buybit clause?\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":120,\"description\":\"4 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":20,\"totalDuration\":120}],\"totalModifierPrice\":20,\"totalModifierDuration\":120}]', NULL),
(109, 3, 73, 37, 15, NULL, '2025-08-24 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 16:00:39', '2025-08-23 16:01:06', 0, NULL, NULL, NULL, 420, 1, 0, 280.00, 0.00, 0.00, 0.00, 280.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Moving Service', NULL, 0, '[]', 0.00, 0.00, 420, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":1,\"totalPrice\":15,\"totalDuration\":90}],\"totalModifierPrice\":15,\"totalModifierDuration\":90}]', NULL),
(110, 3, 76, 38, NULL, NULL, '2025-08-18 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 17:05:21', '2025-08-23 17:05:21', 0, NULL, NULL, NULL, 450, 1, 0, 110.00, 0.00, 0.00, 0.00, 110.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '146 NITEL JUNCTION 146 Nitel Junction State', '', '', '', 'USA', NULL, NULL, 'Beat cows', NULL, 0, '[]', 0.00, 0.00, 450, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755595518071,\"title\":\"will you eat?\",\"description\":\"eating\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":60,\"description\":\"giving food\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":15,\"totalDuration\":60}],\"totalModifierPrice\":15,\"totalModifierDuration\":60},{\"id\":1755689702257,\"title\":\"Buybit clause?\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":120,\"description\":\"4 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"3 of 5\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":2,\"totalPrice\":20,\"totalDuration\":120}],\"totalModifierPrice\":20,\"totalModifierDuration\":120}]', NULL),
(111, 3, 38, 43, NULL, NULL, '2025-08-31 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 17:07:54', '2025-08-23 17:07:54', 0, NULL, NULL, NULL, 90, 1, 0, 30.00, 0.00, 0.00, 0.00, 30.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Plantation Palms Blvd, Land O&#x27; Lakes, FL, USA, 554', 'Land O&#x27; Lakes', 'FL', '34639', 'USA', NULL, NULL, 'booo', NULL, 0, '[]', 0.00, 0.00, 90, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(112, 3, 76, 23, NULL, NULL, '2025-09-01 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 21:33:20', '2025-08-23 21:33:20', 0, NULL, NULL, NULL, 30, 1, 0, 30.00, 0.00, 0.00, 0.00, 30.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '146 NITEL JUNCTION 146 Nitel Junction State', '', '', '', 'USA', NULL, NULL, 'Barbing', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(113, 3, 66, 23, 2, NULL, '2025-08-29 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 22:33:46', '2025-08-23 22:34:30', 0, NULL, NULL, NULL, 30, 1, 0, 30.00, 0.00, 0.00, 0.00, 30.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Chelhar Lane', 'Channing', 'MI', '', 'USA', NULL, NULL, 'Barbing', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL);
INSERT INTO `jobs` (`id`, `user_id`, `customer_id`, `service_id`, `team_member_id`, `territory_id`, `scheduled_date`, `notes`, `status`, `invoice_status`, `invoice_id`, `invoice_amount`, `invoice_date`, `payment_date`, `created_at`, `updated_at`, `is_recurring`, `recurring_frequency`, `next_billing_date`, `stripe_payment_intent_id`, `duration`, `workers`, `skills_required`, `price`, `discount`, `additional_fees`, `taxes`, `total`, `payment_method`, `territory`, `schedule_type`, `let_customer_schedule`, `offer_to_providers`, `internal_notes`, `contact_info`, `customer_notes`, `scheduled_time`, `service_address_street`, `service_address_city`, `service_address_state`, `service_address_zip`, `service_address_country`, `service_address_lat`, `service_address_lng`, `service_name`, `bathroom_count`, `workers_needed`, `skills`, `service_price`, `total_amount`, `estimated_duration`, `special_instructions`, `payment_status`, `priority`, `quality_check`, `photos_required`, `customer_signature`, `auto_invoice`, `auto_reminders`, `recurring_end_date`, `tags`, `intake_question_answers`, `service_modifiers`, `service_intake_questions`) VALUES
(114, 5, 75, 45, NULL, NULL, '2025-08-13 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 22:43:10', '2025-08-23 22:43:10', 0, NULL, NULL, NULL, 270, 1, 0, 225.98, 0.00, 0.00, 0.00, 225.98, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '5631 Raven Ct.', '', '', '', 'USA', NULL, NULL, 'Freon adding', NULL, 0, '[]', 0.00, 0.00, 270, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755556224588,\"title\":\"Small appliance \",\"description\":\"type of appliance \",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":33,\"duration\":60,\"description\":\"Small\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556161844-cnfw4v3futw.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":44,\"duration\":44,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556184188-dl1icio6qji.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":33,\"duration\":60,\"description\":\"Small\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556161844-cnfw4v3futw.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":33,\"totalDuration\":60}],\"totalModifierPrice\":33,\"totalModifierDuration\":60},{\"id\":1755556305676,\"title\":\"Fridge features\",\"description\":\"adsfdsaf\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"Shelves\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556269108-xvrgf1f6zal.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":20,\"description\":\"Doors\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556290894-vfu79u8qgsm.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":20,\"description\":\"Doors\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556290894-vfu79u8qgsm.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":20,\"totalDuration\":20}],\"totalModifierPrice\":20,\"totalModifierDuration\":20},{\"id\":1755556359818,\"title\":\"Fridge doors\",\"description\":\"How many doors\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"1 door\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556338234-9ftn76iow96.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"1 door\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556338234-9ftn76iow96.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selectedQuantity\":1,\"totalPrice\":10,\"totalDuration\":10}],\"totalModifierPrice\":10,\"totalModifierDuration\":10}]', NULL),
(115, 3, 73, 23, NULL, NULL, '2025-08-24 10:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 23:32:30', '2025-08-23 23:32:30', 0, NULL, NULL, NULL, 30, 1, 0, 30.00, 0.00, 0.00, 0.00, 30.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Barbing', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(116, 3, 78, 23, NULL, NULL, '2025-08-29 10:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-23 23:33:21', '2025-08-23 23:33:21', 0, NULL, NULL, NULL, 30, 1, 0, 30.00, 0.00, 0.00, 0.00, 30.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', 'Chelton Road', 'Colorado Springs', 'CO', '', 'USA', NULL, NULL, 'Barbing', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(117, 5, 74, 45, NULL, NULL, '2025-08-13 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 00:00:40', '2025-08-24 00:00:40', 0, NULL, NULL, NULL, 230, 1, 0, 185.98, 0.00, 0.00, 0.00, 185.98, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '5631 Raven Ct.', '', '', '', 'USA', NULL, NULL, 'Freon adding', NULL, 0, '[]', 0.00, 0.00, 230, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755556224588,\"title\":\"Small appliance \",\"description\":\"type of appliance \",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":33,\"duration\":60,\"description\":\"Small\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556161844-cnfw4v3futw.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":44,\"duration\":44,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556184188-dl1icio6qji.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":33,\"duration\":60,\"description\":\"Small\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556161844-cnfw4v3futw.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":33,\"totalDuration\":60}],\"totalModifierPrice\":33,\"totalModifierDuration\":60},{\"id\":1755556305676,\"title\":\"Fridge features\",\"description\":\"adsfdsaf\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"Shelves\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556269108-xvrgf1f6zal.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":20,\"description\":\"Doors\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556290894-vfu79u8qgsm.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"Shelves\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556269108-xvrgf1f6zal.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":10,\"totalDuration\":10}],\"totalModifierPrice\":10,\"totalModifierDuration\":10},{\"id\":1755556359818,\"title\":\"Fridge doors\",\"description\":\"How many doors\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"1 door\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556338234-9ftn76iow96.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[],\"totalModifierPrice\":0,\"totalModifierDuration\":0}]', NULL),
(118, 5, 72, 65, NULL, NULL, '2025-08-29 10:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 00:01:39', '2025-08-24 00:01:39', 0, NULL, NULL, NULL, 30, 1, 0, 0.00, 0.00, 0.00, 0.00, 0.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '5631 Raven Ct, Shelbyville, KY, USA', 'Shelbyville', 'KY', '40065', 'USA', NULL, NULL, 'asdfdsaf', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(119, 3, 73, 62, NULL, NULL, '2025-08-25 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 00:31:33', '2025-08-24 00:31:33', 0, NULL, NULL, NULL, 150, 1, 0, 50.00, 0.00, 0.00, 0.00, 50.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Dispatch', NULL, 0, '[]', 0.00, 0.00, 150, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755985456596,\"title\":\"Ride\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":5,\"duration\":30,\"description\":\"book\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"Cart\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":1,\"label\":\"\",\"price\":5,\"duration\":30,\"description\":\"book\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":5,\"totalDuration\":30}],\"totalModifierPrice\":5,\"totalModifierDuration\":30}]', NULL),
(120, 3, 73, 62, NULL, NULL, '2025-08-23 10:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 00:45:29', '2025-08-24 00:45:29', 0, NULL, NULL, NULL, 210, 1, 0, 60.00, 0.00, 0.00, 0.00, 60.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Dispatch', NULL, 0, '[]', 0.00, 0.00, 210, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, '[{\"id\":1755985456596,\"title\":\"Ride\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":5,\"duration\":30,\"description\":\"book\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"Cart\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}],\"selectedOptions\":[{\"id\":2,\"label\":\"\",\"price\":10,\"duration\":60,\"description\":\"Cart\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false,\"selected\":true,\"totalPrice\":10,\"totalDuration\":60}],\"totalModifierPrice\":10,\"totalModifierDuration\":60}]', NULL),
(121, 3, 73, 23, NULL, NULL, '2025-08-23 10:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 01:27:15', '2025-08-24 01:27:15', 0, NULL, NULL, NULL, 30, 1, 0, 30.00, 0.00, 0.00, 0.00, 30.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '6 opposite school gate', 'iworoko rd', '', '', 'USA', NULL, NULL, 'Barbing', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(122, 5, 74, 65, NULL, NULL, '2025-08-24 09:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 19:02:45', '2025-08-24 19:02:45', 0, NULL, NULL, NULL, 30, 1, 0, 0.00, 0.00, 0.00, 0.00, 0.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '5631 Raven Ct.', '', '', '', 'USA', NULL, NULL, 'asdfdsaf', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL),
(123, 5, 72, 65, 9, NULL, '2025-08-24 11:00:00', '', 'pending', 'draft', NULL, NULL, NULL, NULL, '2025-08-24 19:09:13', '2025-08-24 19:09:31', 0, NULL, NULL, NULL, 30, 1, 0, 0.00, 0.00, 0.00, 0.00, 0.00, '', '', 'one-time', 0, 0, '', NULL, '', '09:00:00', '12001 Dr M.L.K. Jr St N', 'St. Petersburg', 'FL', '33716', 'USA', NULL, NULL, 'asdfdsaf', NULL, 0, '[]', 0.00, 0.00, 30, '', 'pending', 'normal', 1, 0, 0, 1, 1, NULL, '[]', NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `job_answers`
--

CREATE TABLE `job_answers` (
  `id` int NOT NULL,
  `job_id` int NOT NULL,
  `question_id` varchar(255) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'ID of the intake question',
  `question_text` text COLLATE utf8mb4_general_ci NOT NULL COMMENT 'The actual question text',
  `question_type` varchar(50) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Type of question (dropdown, multiple_choice, text, etc.)',
  `answer` text COLLATE utf8mb4_general_ci COMMENT 'Customer answer to the question',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `job_answers`
--

INSERT INTO `job_answers` (`id`, `job_id`, `question_id`, `question_text`, `question_type`, `answer`, `created_at`, `updated_at`) VALUES
(51, 92, '3', 'What color are you pets?', 'color_choice', '[\"#00ff00\"]', '2025-08-22 11:31:43', '2025-08-22 11:31:43'),
(52, 107, '1755308810829', 'Oven', 'color_choice', '[\"#3f2727\",\"#FFFF00\"]', '2025-08-23 14:53:21', '2025-08-23 14:53:21'),
(53, 107, '1755308949833', 'Oven', 'picture_choice', '{\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"}', '2025-08-23 14:53:21', '2025-08-23 14:53:21'),
(54, 108, '1', 'will you drop me?', 'dropdown', '[\"No\",\"of course\",\"I won\'t\"]', '2025-08-23 14:54:42', '2025-08-23 14:54:42'),
(55, 108, '2', 'Select 234', 'dropdown', '[\"option 1\"]', '2025-08-23 14:54:42', '2025-08-23 14:54:42'),
(56, 108, '3', 'Best des', 'dropdown', 'opti 1', '2025-08-23 14:54:42', '2025-08-23 14:54:42'),
(57, 109, '1755308763534', '', 'image_upload', 'https://zenbookapi.now2code.online/uploads/intake-image-1755964818394-8usztwgc5zx.jpeg', '2025-08-23 16:00:39', '2025-08-23 16:00:39'),
(58, 109, '1755308810829', 'Oven', 'color_choice', '[\"#FFFF00\",\"#32CD32\"]', '2025-08-23 16:00:39', '2025-08-23 16:00:39'),
(59, 109, '1755308949833', 'Oven', 'picture_choice', '{\"text\":\"delah\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"}', '2025-08-23 16:00:39', '2025-08-23 16:00:39'),
(60, 110, '1', 'will you drop me?', 'dropdown', '[\"No\",\"of course\"]', '2025-08-23 17:05:21', '2025-08-23 17:05:21'),
(61, 110, '2', 'Select 234', 'dropdown', '[\"option 1\"]', '2025-08-23 17:05:21', '2025-08-23 17:05:21'),
(62, 110, '3', 'Best des', 'dropdown', 'opti 1', '2025-08-23 17:05:21', '2025-08-23 17:05:21'),
(63, 112, '1755300845702', 'Oven', 'color_choice', '[\"#FF0000\",\"#FFA500\"]', '2025-08-23 21:33:20', '2025-08-23 21:33:20'),
(64, 112, '1755301065887', 'Oven', 'picture_choice', '{\"text\":\"dueler\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755301052564-mbeoac2y9yb.jpg\"}', '2025-08-23 21:33:20', '2025-08-23 21:33:20'),
(65, 113, '1755300845702', 'Oven', 'color_choice', '[\"#FF0000\",\"#FFA500\"]', '2025-08-23 22:33:46', '2025-08-23 22:33:46'),
(66, 113, '1755301065887', 'Oven', 'picture_choice', '{\"text\":\"orang\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755300881936-ruwmduida6.jpg\"}', '2025-08-23 22:33:46', '2025-08-23 22:33:46'),
(67, 114, '1', 'Do you have pets?', 'dropdown', 'No', '2025-08-23 22:43:10', '2025-08-23 22:43:10'),
(68, 115, '1755300845702', 'Oven', 'color_choice', '[\"#FF0000\",\"#FFA500\"]', '2025-08-23 23:32:30', '2025-08-23 23:32:30'),
(69, 115, '1755301065887', 'Oven', 'picture_choice', '{\"text\":\"orang\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755300881936-ruwmduida6.jpg\"}', '2025-08-23 23:32:30', '2025-08-23 23:32:30'),
(70, 116, '1755300845702', 'Oven', 'color_choice', '[\"#FF6347\"]', '2025-08-23 23:33:21', '2025-08-23 23:33:21'),
(71, 116, '1755301065887', 'Oven', 'picture_choice', '{\"text\":\"orang\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755300881936-ruwmduida6.jpg\"}', '2025-08-23 23:33:21', '2025-08-23 23:33:21'),
(72, 121, '1755300845702', 'Oven', 'color_choice', '[\"#FF0000\",\"#FFA500\"]', '2025-08-24 01:27:15', '2025-08-24 01:27:15'),
(73, 121, '1755301065887', 'Oven', 'picture_choice', '{\"text\":\"orang\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755300881936-ruwmduida6.jpg\"}', '2025-08-24 01:27:15', '2025-08-24 01:27:15');

-- --------------------------------------------------------

--
-- Table structure for table `job_team_assignments`
--

CREATE TABLE `job_team_assignments` (
  `id` int NOT NULL,
  `job_id` int NOT NULL,
  `team_member_id` int NOT NULL,
  `is_primary` tinyint(1) DEFAULT '0' COMMENT 'Whether this is the primary team member',
  `assigned_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `assigned_by` int DEFAULT NULL COMMENT 'User ID who made the assignment'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `job_team_assignments`
--

INSERT INTO `job_team_assignments` (`id`, `job_id`, `team_member_id`, `is_primary`, `assigned_at`, `assigned_by`) VALUES
(72, 67, 10, 1, '2025-08-16 02:30:26', 3),
(73, 68, 10, 1, '2025-08-16 03:02:37', 3),
(74, 69, 11, 1, '2025-08-16 03:14:52', 3),
(75, 70, 11, 1, '2025-08-16 03:24:26', 3),
(76, 71, 12, 1, '2025-08-16 03:47:04', 3),
(77, 72, 11, 1, '2025-08-16 04:01:27', 3),
(78, 73, 11, 1, '2025-08-16 20:32:42', 3),
(79, 73, 12, 0, '2025-08-16 21:10:49', NULL),
(80, 74, 12, 1, '2025-08-16 21:24:41', NULL),
(81, 75, 12, 1, '2025-08-16 21:31:42', 3),
(82, 77, 11, 1, '2025-08-18 16:35:31', 3),
(83, 80, 11, 1, '2025-08-20 20:38:01', 3),
(84, 81, 11, 1, '2025-08-20 20:41:14', 3),
(85, 82, 13, 1, '2025-08-21 07:03:37', 3),
(86, 87, 12, 1, '2025-08-21 12:05:55', NULL),
(87, 88, 11, 1, '2025-08-21 12:58:19', 3),
(88, 89, 6, 1, '2025-08-21 20:32:59', 5),
(89, 89, 14, 0, '2025-08-21 20:32:59', 5),
(90, 92, 9, 1, '2025-08-22 11:31:43', 5),
(93, 66, 16, 1, '2025-08-23 16:44:46', 3),
(94, 96, 13, 1, '2025-08-23 16:45:15', 3),
(95, 113, 2, 1, '2025-08-23 22:34:30', 3),
(96, 123, 9, 1, '2025-08-24 19:09:31', 5);

-- --------------------------------------------------------

--
-- Table structure for table `job_templates`
--

CREATE TABLE `job_templates` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `service_id` int NOT NULL,
  `estimated_duration` int DEFAULT NULL,
  `estimated_price` decimal(10,2) DEFAULT NULL,
  `default_notes` text COLLATE utf8mb4_general_ci,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notification_templates`
--

CREATE TABLE `notification_templates` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `template_type` enum('email','sms') COLLATE utf8mb4_general_ci NOT NULL,
  `notification_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `subject` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `is_enabled` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `notification_templates`
--

INSERT INTO `notification_templates` (`id`, `user_id`, `template_type`, `notification_name`, `subject`, `content`, `is_enabled`, `created_at`, `updated_at`) VALUES
(1, 1, 'email', 'appointment_confirmation', 'Appointment Confirmed - {business_name}', 'Hi {customer_name},\n\nYour appointment has been confirmed for {appointment_date} at {appointment_time}.\n\nService: {service_name}\nLocation: {location}\n\nWe look forward to serving you!\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(2, 1, 'sms', 'appointment_confirmation', NULL, 'Hi {customer_name}, your appointment is confirmed for {appointment_date} at {appointment_time}. Service: {service_name}. Location: {location}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(3, 1, 'email', 'appointment_reminder', 'Appointment Reminder - {business_name}', 'Hi {customer_name},\n\nThis is a friendly reminder about your upcoming appointment:\n\nDate: {appointment_date}\nTime: {appointment_time}\nService: {service_name}\nLocation: {location}\n\nPlease let us know if you need to reschedule.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(4, 1, 'sms', 'appointment_reminder', NULL, 'Reminder: Your appointment is tomorrow at {appointment_time}. Service: {service_name}. Location: {location}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(5, 1, 'email', 'appointment_cancelled', 'Appointment Cancelled - {business_name}', 'Hi {customer_name},\n\nYour appointment scheduled for {appointment_date} at {appointment_time} has been cancelled.\n\nService: {service_name}\n\nIf you have any questions, please contact us.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(6, 1, 'sms', 'appointment_cancelled', NULL, 'Your appointment for {appointment_date} at {appointment_time} has been cancelled. Service: {service_name}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(7, 1, 'email', 'appointment_rescheduled', 'Appointment Rescheduled - {business_name}', 'Hi {customer_name},\n\nYour appointment has been rescheduled:\n\nNew Date: {new_appointment_date}\nNew Time: {new_appointment_time}\nService: {service_name}\nLocation: {location}\n\nWe apologize for any inconvenience.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(8, 1, 'sms', 'appointment_rescheduled', NULL, 'Your appointment has been rescheduled to {new_appointment_date} at {new_appointment_time}. Service: {service_name}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(9, 1, 'email', 'enroute', 'We\'re On Our Way - {business_name}', 'Hi {customer_name},\n\nWe\'re on our way to your appointment!\n\nEstimated arrival: {eta}\nService: {service_name}\nLocation: {location}\n\nWe\'ll see you soon!\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(10, 1, 'sms', 'enroute', NULL, 'We\'re on our way! ETA: {eta}. Service: {service_name}. Location: {location}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(11, 1, 'email', 'job_follow_up', 'How Was Your Service? - {business_name}', 'Hi {customer_name},\n\nThank you for choosing {business_name} for your recent service.\n\nWe hope you were satisfied with our work. Please take a moment to rate your experience and provide feedback.\n\nService: {service_name}\nDate: {service_date}\n\nYour feedback helps us improve our services.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(12, 1, 'email', 'payment_receipt', 'Payment Receipt - {business_name}', 'Hi {customer_name},\n\nThank you for your payment. Here is your receipt:\n\nService: {service_name}\nDate: {service_date}\nAmount: {amount}\nPayment Method: {payment_method}\n\nThank you for choosing {business_name}!\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(13, 1, 'email', 'invoice', 'Invoice - {business_name}', 'Hi {customer_name},\n\nPlease find attached your invoice for the following service:\n\nService: {service_name}\nDate: {service_date}\nAmount: {amount}\n\nPlease pay by {due_date}.\n\nThank you,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(14, 1, 'email', 'estimate', 'Your Estimate is Ready - {business_name}', 'Hi {customer_name},\n\nYour estimate is ready!\n\nService: {service_name}\nEstimated Amount: {estimated_amount}\n\nPlease review the details and let us know if you\'d like to proceed with the booking.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(15, 1, 'sms', 'estimate', NULL, 'Your estimate is ready! Service: {service_name}. Amount: {estimated_amount}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(16, 1, 'email', 'quote_request_processing', 'Quote Request Received - {business_name}', 'Hi {customer_name},\n\nThank you for your quote request. We have received your inquiry and will review it carefully.\n\nWe\'ll get back to you within 24 hours with a detailed quote.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(17, 1, 'email', 'booking_request_acknowledgment', 'Booking Request Received - {business_name}', 'Hi {customer_name},\n\nThank you for your booking request. We have received your inquiry and will confirm your appointment shortly.\n\nWe\'ll contact you within 2 hours to confirm the details.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(18, 1, 'email', 'recurring_booking_cancelled', 'Recurring Booking Cancelled - {business_name}', 'Hi {customer_name},\n\nYour recurring booking has been cancelled as requested.\n\nService: {service_name}\n\nIf you need to reschedule or have any questions, please contact us.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(19, 1, 'sms', 'recurring_booking_cancelled', NULL, 'Your recurring booking has been cancelled. Service: {service_name}. - {business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(20, 1, 'email', 'contact_customer', 'Message from {business_name}', 'Hi {customer_name},\n\n{message_content}\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(21, 1, 'email', 'team_member_invite', 'Welcome to {business_name} Team', 'Hi {team_member_name},\n\nWelcome to the {business_name} team!\n\nYour account has been created. Please click the link below to set up your password and complete your profile:\n\n{invite_link}\n\nIf you have any questions, please contact us.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(22, 1, 'email', 'assigned_job_cancelled', 'Job Assignment Cancelled - {business_name}', 'Hi {team_member_name},\n\nThe job you were assigned to has been cancelled:\n\nJob: {job_title}\nCustomer: {customer_name}\nDate: {job_date}\nTime: {job_time}\n\nYou are no longer assigned to this job.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50'),
(23, 1, 'email', 'assigned_job_rescheduled', 'Job Assignment Rescheduled - {business_name}', 'Hi {team_member_name},\n\nThe job you were assigned to has been rescheduled:\n\nJob: {job_title}\nCustomer: {customer_name}\nNew Date: {new_job_date}\nNew Time: {new_job_time}\n\nPlease update your schedule accordingly.\n\nBest regards,\n{business_name}', 1, '2025-08-10 23:28:50', '2025-08-10 23:28:50');

-- --------------------------------------------------------

--
-- Table structure for table `requests`
--

CREATE TABLE `requests` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `customer_id` int DEFAULT NULL,
  `customer_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `customer_email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `service_id` int DEFAULT NULL,
  `type` enum('booking','quote') COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('pending','approved','rejected','cancelled') COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `scheduled_date` date DEFAULT NULL,
  `scheduled_time` time DEFAULT NULL,
  `estimated_duration` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `estimated_price` decimal(10,2) DEFAULT NULL,
  `notes` text COLLATE utf8mb4_general_ci,
  `rejection_reason` text COLLATE utf8mb4_general_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `requests`
--

INSERT INTO `requests` (`id`, `user_id`, `customer_id`, `customer_name`, `customer_email`, `service_id`, `type`, `status`, `scheduled_date`, `scheduled_time`, `estimated_duration`, `estimated_price`, `notes`, `rejection_reason`, `created_at`, `updated_at`) VALUES
(5, 3, 1, 'OLAMILEKAN AJAJA', 'ajajaolamilekan7@gmail.com', 1, 'booking', 'approved', '2025-01-15', '09:00:00', '2 hours', 150.00, 'Kitchen cleaning needed', 'nothing', '2025-07-19 02:28:38', '2025-07-19 02:48:36'),
(6, 3, 1, 'OLAMILEKAN AJAJA', 'ajajaolamilekan7@gmail.com', 7, 'quote', 'approved', '2025-01-16', '14:00:00', '3 hours', 200.00, 'Deep cleaning quote requested', NULL, '2025-07-19 02:28:38', '2025-07-19 03:02:03'),
(7, 1, 1, 'OLAMILEKAN AJAJA', 'ajajaolamilekan7@gmail.com', 8, 'booking', 'approved', '2025-01-17', '10:00:00', '1.5 hours', 100.00, 'Regular maintenance', NULL, '2025-07-19 02:28:38', '2025-07-19 02:28:38'),
(8, 1, 1, 'OLAMILEKAN AJAJA', 'ajajaolamilekan7@gmail.com', 9, 'quote', 'rejected', '2025-01-18', '16:00:00', '4 hours', 300.00, 'Too expensive for customer', NULL, '2025-07-19 02:28:38', '2025-07-19 02:28:38'),
(9, 1, 1, NULL, NULL, 1, 'booking', 'pending', '2025-01-15', '09:00:00', '2 hours', 150.00, 'Kitchen cleaning needed', NULL, '2025-07-19 18:58:21', '2025-07-19 18:58:21'),
(10, 1, 1, NULL, NULL, 7, 'quote', 'pending', '2025-01-16', '14:00:00', '3 hours', 200.00, 'Deep cleaning quote requested', NULL, '2025-07-19 18:58:21', '2025-07-19 18:58:21'),
(11, 1, 1, NULL, NULL, 8, 'booking', 'approved', '2025-01-17', '10:00:00', '1.5 hours', 100.00, 'Regular maintenance', NULL, '2025-07-19 18:58:21', '2025-07-19 18:58:21'),
(12, 1, 1, NULL, NULL, 9, 'quote', 'rejected', '2025-01-18', '16:00:00', '4 hours', 300.00, 'Too expensive for customer', NULL, '2025-07-19 18:58:21', '2025-07-19 18:58:21'),
(13, 3, 14, 'Adeniyi Adejuwon', 'adeniyiadejuwon0@gmail.com', NULL, 'quote', 'approved', '2025-07-22', NULL, NULL, NULL, 'Service Type: 6\nDescription: I want to remake my toilet sink\nUrgency: normal\nBudget: under-500\nAdditional Info: ', NULL, '2025-07-19 21:28:33', '2025-07-19 21:28:51'),
(14, 3, 20, 'Adeniyi Adejuwon', 'adeniyiadejuwon@gmail.com', NULL, 'quote', 'approved', '2025-07-25', NULL, NULL, NULL, 'Service Type: custom\nDescription: some shit packing\nUrgency: normal\nBudget: 500-1000\nAdditional Info: ', NULL, '2025-07-19 22:20:41', '2025-07-19 22:21:32'),
(15, 6, 22, 'oyewole precious anuoluwapo', 'preciousanuoluwapo07@gmail.com', NULL, 'quote', 'rejected', '2025-07-23', NULL, NULL, NULL, 'Service Type: custom\nDescription: i want you to rob a bank\nUrgency: low\nBudget: over-10000\nAdditional Info: we have guns', 'you are nor fiif', '2025-07-22 19:27:37', '2025-07-22 19:29:35'),
(16, 6, 22, 'oyewole precious anuoluwapo', 'preciousanuoluwapo07@gmail.com', NULL, 'quote', 'approved', '2025-07-23', NULL, NULL, NULL, 'Service Type: custom\nDescription: i want you to rob a bank\nUrgency: low\nBudget: over-10000\nAdditional Info: we have guns', NULL, '2025-07-22 19:27:37', '2025-07-22 19:29:45'),
(17, 3, 14, 'jamsy', 'adeniyiadejuwon0@gmail.com', NULL, 'quote', 'approved', '2025-07-26', NULL, NULL, NULL, 'Service Type: 6\nDescription: Better than ever\nUrgency: high\nBudget: 500-1000\nAdditional Info: ', NULL, '2025-07-22 19:40:56', '2025-07-22 19:41:20'),
(18, 3, 42, 'Adeniyi Adejuwon', 'adeniyiadejuwon99@gmail.com', NULL, 'quote', 'approved', '2025-07-30', NULL, NULL, NULL, 'Service Type: custom\nDescription: I need some serious wig distribution\nUrgency: low\nBudget: under-500\nAdditional Info: ', NULL, '2025-07-26 01:33:40', '2025-07-26 01:34:42');

-- --------------------------------------------------------

--
-- Table structure for table `services`
--

CREATE TABLE `services` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `price` decimal(10,2) DEFAULT NULL,
  `duration` int DEFAULT NULL,
  `category` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `image` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'URL to service image',
  `modifiers` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `require_payment_method` tinyint(1) DEFAULT '0',
  `is_active` tinyint(1) DEFAULT '1' COMMENT 'Whether the service is active and visible',
  `intake_questions` json DEFAULT NULL,
  `category_id` int DEFAULT NULL
) ;

--
-- Dumping data for table `services`
--

INSERT INTO `services` (`id`, `user_id`, `name`, `description`, `price`, `duration`, `category`, `image`, `modifiers`, `created_at`, `updated_at`, `require_payment_method`, `is_active`, `intake_questions`, `category_id`) VALUES
(1, 2, 'Home Cleaning', 'Comprehensive home cleaning services for residential properties', 100.00, 180, 'Cleaning', NULL, '[]', '2025-07-12 02:30:35', '2025-08-17 21:15:01', 0, 1, NULL, 1),
(4, 1, 'Plumbing Service', 'Emergency and routine plumbing repairs and installations', 95.00, 60, 'Repair', NULL, '[]', '2025-07-15 01:12:20', '2025-08-17 21:15:01', 0, 1, NULL, 10),
(5, 1, 'Carpet Cleaning', 'Deep carpet cleaning and stain removal services', 75.00, 150, 'Cleaning', NULL, '[]', '2025-07-15 01:29:47', '2025-08-17 21:15:01', 0, 1, NULL, 2),
(6, 3, 'Plumbing Service', 'Emergency and routine plumbing repairs and installations', 95.00, 60, 'Moving', NULL, '[]', '2025-07-16 02:08:13', '2025-08-21 12:22:05', 0, 1, '[]', NULL),
(7, 1, 'Regular House Cleaning', 'Standard cleaning service for homes up to 2000 sq ft', 150.00, 120, 'cleaning', NULL, '[]', '2025-07-18 21:06:42', '2025-08-17 21:15:01', 0, 1, NULL, 2),
(8, 1, 'Deep Cleaning', 'Comprehensive cleaning including hard-to-reach areas', 250.00, 180, 'cleaning', NULL, '[]', '2025-07-18 21:06:42', '2025-08-17 21:15:01', 0, 1, NULL, 2),
(9, 1, 'Window Cleaning', 'Professional window and screen cleaning', 100.00, 60, 'cleaning', NULL, '[]', '2025-07-18 21:06:42', '2025-08-17 21:15:01', 0, 1, NULL, 2),
(10, 1, 'Carpet Cleaning', 'Deep carpet cleaning and stain removal', 200.00, 90, 'cleaning', NULL, '[]', '2025-07-18 21:06:42', '2025-08-17 21:15:01', 0, 1, NULL, 2),
(11, 1, 'Move-in/Move-out Cleaning', 'Complete cleaning for moving situations', 300.00, 240, 'cleaning', NULL, '[]', '2025-07-18 21:06:42', '2025-08-17 21:15:01', 0, 1, NULL, 2),
(12, 4, 'Regular House Cleaning', 'Standard house cleaning service including dusting, vacuuming, and bathroom cleaning', 150.00, 120, 'Cleaning', NULL, '[]', '2025-07-19 19:03:43', '2025-08-17 21:15:01', 0, 1, NULL, 3),
(13, 4, 'Deep Cleaning', 'Comprehensive deep cleaning service including baseboards, inside appliances, and detailed attention', 250.00, 180, 'Cleaning', NULL, '[]', '2025-07-19 19:03:43', '2025-08-17 21:15:01', 0, 1, NULL, 3),
(14, 4, 'Window Cleaning', 'Professional window cleaning service for all windows in your home', 100.00, 60, 'Cleaning', NULL, '[]', '2025-07-19 19:03:43', '2025-08-17 21:15:01', 0, 1, NULL, 3),
(15, 4, 'Carpet Cleaning', 'Deep carpet cleaning and stain removal service', 200.00, 90, 'Cleaning', NULL, '[]', '2025-07-19 19:03:43', '2025-08-17 21:15:01', 0, 1, NULL, 3),
(16, 4, 'Move-in/Move-out Cleaning', 'Complete cleaning service for move-in or move-out situations', 300.00, 240, 'Cleaning', NULL, '[]', '2025-07-19 19:03:43', '2025-08-17 21:15:01', 0, 1, NULL, 3),
(19, 6, 'cleaner', 'asdg,agsdiagsidug', 0.00, 150, 'cleaning', NULL, '[]', '2025-07-22 18:46:37', '2025-08-17 21:15:01', 0, 1, NULL, 4),
(20, 7, 'Junk Removal', 'Remove unwanted items from homes, offices, or construction sites', 150.00, 120, 'Removal', NULL, '[]', '2025-07-26 20:17:17', '2025-08-17 21:15:01', 0, 1, NULL, 11),
(23, 3, 'Barbing', 'Barb here', 30.00, 30, '', 'https://zenbookapi.now2code.online/uploads/service-image-1755300742444-qbrxynltzus.png', '[]', '2025-08-04 12:18:50', '2025-08-19 11:25:20', 0, 1, '[{\"id\": 1755300845702, \"options\": [{\"id\": 2, \"text\": \"#FF0000\", \"image\": \"\"}, {\"id\": 3, \"text\": \"#FFA500\", \"image\": \"\"}, {\"id\": 4, \"text\": \"#FF6347\", \"image\": \"\"}], \"question\": \"Oven\", \"required\": false, \"description\": \"\", \"questionType\": \"color_choice\", \"selectionType\": \"multi\"}, {\"id\": 1755301065887, \"options\": [{\"id\": 2, \"text\": \"orang\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755300881936-ruwmduida6.jpg\"}, {\"id\": 3, \"text\": \"dueler\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755301052564-mbeoac2y9yb.jpg\"}], \"question\": \"Oven\", \"required\": false, \"description\": \"\", \"questionType\": \"picture_choice\", \"selectionType\": \"single\"}, {\"id\": 1755305859899, \"options\": [{\"id\": 1, \"text\": \"\"}], \"question\": \"\", \"required\": false, \"description\": \"\", \"questionType\": \"image_upload\", \"selectionType\": \"single\"}]', NULL),
(25, 10, 'testing', 'testing', 5.00, 12, 'cleaning', NULL, '[]', '2025-08-06 14:31:56', '2025-08-17 21:15:01', 0, 1, NULL, 5),
(31, 3, 'Flushing', 'Flushing bathrooms', 90.00, 70, '', 'https://zenbookapi.now2code.online/uploads/service-image-1755034399649-bxo21o3fkow.jpg', '[]', '2025-08-08 11:20:57', '2025-08-19 11:25:20', 0, 1, '[]', NULL),
(32, 3, 'Fishing', 'Fishing hook', 50.00, 60, 'fishing', 'https://zenbookapi.now2code.online/uploads/service-image-1755130961556-1ibqohng51h.jpeg', '[{\"id\":1754809842764,\"title\":\"Bandwangs\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":20,\"duration\":60,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755094566780-hyaza4l36i5.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":10,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755097686707-9rw6ex3i77m.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-08 11:34:46', '2025-08-18 08:12:36', 0, 1, '[{\"id\": 1754810643344, \"options\": [{\"id\": 1, \"text\": \"twills\"}, {\"id\": 2, \"text\": \"sardine\"}], \"question\": \"Best of it?\", \"required\": false, \"description\": \"\", \"questionType\": \"dropdown\", \"selectionType\": \"single\"}, {\"id\": 1754813187019, \"options\": [{\"id\": 1, \"text\": \"fish\"}, {\"id\": 2, \"text\": \"egg\"}], \"question\": \"Best meal?\", \"required\": false, \"description\": \"\", \"questionType\": \"multiple_choice\", \"selectionType\": \"single\"}, {\"id\": \"1755031491149\", \"options\": [{\"id\": 1, \"text\": \"twills\"}, {\"id\": 2, \"text\": \"sardine\"}], \"question\": \"Best of them?\", \"required\": false, \"description\": \"\", \"questionType\": \"dropdown\", \"selectionType\": \"multi\"}, {\"id\": \"1755212696431\", \"options\": [{\"id\": 1, \"text\": \"fish\"}, {\"id\": 2, \"text\": \"egg\"}], \"question\": \"Best meal? (Copy)\", \"required\": false, \"description\": \"\", \"questionType\": \"multiple_choice\", \"selectionType\": \"single\"}]', 6),
(35, 5, 'Regular cleaning', 'Regular cleaning for residential properties', 120.00, 30, 'Test category', NULL, '[{\"id\":1755178295604,\"title\":\"Bedrooms\",\"description\":\"Number of bedrooms\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":20,\"duration\":30,\"description\":\"1 bedroom\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755178243877-0kotecw91bma.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":40,\"duration\":60,\"description\":\"2 bedrooms\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755178282092-xdok4hn1bj.jpeg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755178373935,\"title\":\"Extras\",\"description\":\"Extra services\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":30,\"duration\":30,\"description\":\"Oven cleaning\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755178338504-ysmnz57sdp.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":30,\"duration\":30,\"description\":\"Fridge cleaning \",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755178358539-kylxko48x28.jpeg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755178433150,\"title\":\"Wondows cleanin\",\"description\":\"How many windows to clean\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":6,\"description\":\"inside\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755178404761-3cut074jzez.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":10,\"duration\":8,\"description\":\"Outside\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755178422044-9b3sy21h43a.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-14 13:26:06', '2025-08-19 15:02:06', 0, 1, '[{\"id\": 1755178476974, \"options\": [{\"id\": 1, \"text\": \"Y\"}, {\"id\": 2, \"text\": \"No\"}], \"question\": \"Do you have pets?\", \"required\": false, \"description\": \"Pets that shed\", \"questionType\": \"dropdown\", \"selectionType\": \"single\"}, {\"id\": 1755178513725, \"options\": [{\"id\": 1, \"text\": \"Dog\"}, {\"id\": 2, \"text\": \"Cat\"}], \"question\": \"Which pets do you have?\", \"required\": false, \"description\": \"Pets bread\", \"questionType\": \"dropdown\", \"selectionType\": \"multi\"}, {\"id\": 1755178541334, \"options\": [{\"id\": 1, \"text\": \"Dog\"}, {\"id\": 2, \"text\": \"Cat\"}], \"question\": \"Which pets do you have?\", \"required\": false, \"description\": \"Pets bread\", \"questionType\": \"multiple_choice\", \"selectionType\": \"multi\"}, {\"id\": 1755178566754, \"options\": [{\"id\": 1, \"text\": \"Yes\"}, {\"id\": 2, \"text\": \"No\"}], \"question\": \"Do you have pets?\", \"required\": false, \"description\": \"Pets bread\", \"questionType\": \"multiple_choice\", \"selectionType\": \"single\"}, {\"id\": 1755178729420, \"options\": [{\"id\": 1, \"text\": \"Yes\"}, {\"id\": 2, \"text\": \"No\"}], \"question\": \"Do you have oven answer shouty?\", \"required\": false, \"description\": \"Oven\", \"questionType\": \"short_text\", \"selectionType\": \"multi\"}, {\"id\": 1755178734226, \"options\": [{\"id\": 1, \"text\": \"Yes\"}, {\"id\": 2, \"text\": \"No\"}], \"question\": \"Do you have oven answer long?\", \"required\": false, \"description\": \"Oven\", \"questionType\": \"long_text\", \"selectionType\": \"multi\"}]', 12),
(36, 3, 'Home Cleaning', 'Comprehensive home cleaning services for residential properties', 80.00, 180, '', NULL, '[]', '2025-08-16 01:43:54', '2025-08-19 09:16:36', 0, 1, '[]', 6),
(37, 3, 'Moving Service', 'Residential and commercial moving services', 250.00, 240, 'Moving', 'https://zenbookapi.now2code.online/uploads/service-image-1755308744779-tcu9ouiktyl.jpg', '[{\"id\":1755309054051,\"title\":\"Modules 1\",\"description\":\"\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":15,\"duration\":90,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755309029532-nggl20z9di9.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-16 01:44:23', '2025-08-17 21:15:01', 0, 1, '[{\"id\": 1755308763534, \"options\": [{\"id\": 1, \"text\": \"\"}], \"question\": \"\", \"required\": false, \"description\": \"\", \"questionType\": \"image_upload\", \"selectionType\": \"single\"}, {\"id\": 1755308810829, \"options\": [{\"id\": 1, \"text\": \"#3f2727\"}, {\"id\": 2, \"text\": \"#FFFF00\", \"image\": \"\"}, {\"id\": 3, \"text\": \"#32CD32\", \"image\": \"\"}], \"question\": \"Oven\", \"required\": false, \"description\": \"\", \"questionType\": \"color_choice\", \"selectionType\": \"multi\"}, {\"id\": 1755308949833, \"options\": [{\"id\": 1, \"text\": \"delah\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755308848121-dd658v08fi.jpg\"}, {\"id\": 2, \"text\": \"\", \"image\": \"\"}], \"question\": \"Oven\", \"required\": false, \"description\": \"\", \"questionType\": \"picture_choice\", \"selectionType\": \"single\"}]', 13),
(38, 3, 'Beat cows', 'Beating of cows', 40.00, 90, 'Cleaning', 'https://zenbookapi.now2code.online/uploads/service-image-1755378764277-5vpmjj72jyy.webp', '\"[{\\\"id\\\":1755595518071,\\\"title\\\":\\\"will you eat?\\\",\\\"description\\\":\\\"eating\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"label\\\":\\\"\\\",\\\"price\\\":15,\\\"duration\\\":60,\\\"description\\\":\\\"giving food\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755595504354-m0oil32jmpd.png\\\",\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false}]},{\\\"id\\\":1755689702257,\\\"title\\\":\\\"Buybit clause?\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"quantity\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"label\\\":\\\"\\\",\\\"price\\\":10,\\\"duration\\\":60,\\\"description\\\":\\\"3 of 5\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false},{\\\"id\\\":2,\\\"label\\\":\\\"\\\",\\\"price\\\":20,\\\"duration\\\":120,\\\"description\\\":\\\"4 of 5\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false}]}]\"', '2025-08-16 21:12:44', '2025-08-22 17:01:53', 0, 1, '\"[{\\\"id\\\":1,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"yes\\\",\\\"image\\\":\\\"\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"No\\\",\\\"image\\\":\\\"\\\"},{\\\"id\\\":3,\\\"text\\\":\\\"of course\\\",\\\"image\\\":\\\"\\\"},{\\\"id\\\":4,\\\"text\\\":\\\"I won\'t\\\",\\\"image\\\":\\\"\\\"}],\\\"question\\\":\\\"will you drop me?\\\",\\\"required\\\":false,\\\"description\\\":\\\"\\\",\\\"questionType\\\":\\\"dropdown\\\",\\\"selectionType\\\":\\\"multi\\\"},{\\\"id\\\":2,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\",\\\"image\\\":\\\"\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"\\\"}],\\\"question\\\":\\\"Select 234\\\",\\\"required\\\":false,\\\"description\\\":\\\"\\\",\\\"questionType\\\":\\\"dropdown\\\",\\\"selectionType\\\":\\\"multi\\\"},{\\\"id\\\":3,\\\"questionType\\\":\\\"dropdown\\\",\\\"question\\\":\\\"Best des\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"opti 1\\\"}]}]\"', 6),
(39, 3, 'HVAC Service', 'Heating, ventilation, and air conditioning maintenance', 125.00, 120, 'Maintenance', 'https://zenbookapi.now2code.online/uploads/service-image-1755379140698-hncct11iict.jpg', '[{\"id\":1755379235107,\"title\":\"How will you like it?\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":20,\"duration\":30,\"description\":\"long like this?\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755379184313-277znzj4tq7.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":30,\"duration\":60,\"description\":\"short note\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755379222055-a4lgcth578h.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-16 21:18:41', '2025-08-17 21:15:01', 0, 1, '[{\"id\": 1, \"options\": [{\"id\": 1, \"text\": \"yes\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755379322873-r5y2yfluah.png\"}, {\"id\": 2, \"text\": \"No\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755379339317-e2nncivoyu5.png\"}], \"question\": \"Will you come?\", \"required\": false, \"description\": \"\", \"questionType\": \"picture_choice\", \"selectionType\": \"single\"}]', 8),
(40, 5, 'Oven repair', 'Some oven repair', 222.00, 30, 'Applience', 'https://zenbookapi.now2code.online/uploads/service-image-1755459424074-96uc64om2yi.jpg', '[{\"id\":1755459484511,\"title\":\"Oven type\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":50,\"duration\":60,\"description\":\"Small oven\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755459455093-pp4906zb9n.webp\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":100,\"duration\":120,\"description\":\"Largge oven\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-17 19:37:04', '2025-08-17 21:15:01', 0, 1, '[{\"id\": 1, \"options\": [{\"id\": 2, \"text\": \"#FFFF00\", \"image\": \"\"}, {\"id\": 3, \"text\": \"#8A2BE2\", \"image\": \"\"}, {\"id\": 4, \"text\": \"#BC8F8F\", \"image\": \"\"}, {\"id\": 5, \"text\": \"#000000\", \"image\": \"\"}], \"question\": \"WHat\'s color is your oven?\", \"required\": false, \"description\": \"Put a color\", \"questionType\": \"color_choice\", \"selectionType\": \"single\"}]', 14),
(42, 3, 'Just web ', 'Not for all ', 300.00, 30, 'Maintenance', 'https://zenbookapi.now2code.online/uploads/service-image-1755534339927-1xb9e90jsox.png', '[]', '2025-08-18 16:25:40', '2025-08-19 16:45:03', 0, 1, '[]', NULL),
(43, 3, 'booo', '', 30.00, 90, 'driving', 'https://zenbookapi.now2code.online/uploads/service-image-1755534456440-1hainkkdcl1h.jpg', '[]', '2025-08-18 16:27:38', '2025-08-18 16:27:38', 0, 1, NULL, 22),
(44, 3, 'Driving', 'Driving lessons', 80.00, 90, 'driving', 'https://zenbookapi.now2code.online/uploads/service-image-1755536142765-cnxfxswt8t.jpg', '[]', '2025-08-18 16:55:43', '2025-08-21 13:05:30', 0, 1, NULL, NULL),
(45, 5, 'Freon adding', 'addin gfrein', 99.98, 90, 'Celaning', 'https://zenbookapi.now2code.online/uploads/service-image-1755550093531-pgjzvyozxcg.jpg', '[{\"id\":1755556224588,\"title\":\"Small appliance \",\"description\":\"type of appliance \",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":33,\"duration\":60,\"description\":\"Small\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556161844-cnfw4v3futw.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":44,\"duration\":44,\"description\":\"\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556184188-dl1icio6qji.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755556305676,\"title\":\"Fridge features\",\"description\":\"adsfdsaf\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"Shelves\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556269108-xvrgf1f6zal.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":20,\"description\":\"Doors\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556290894-vfu79u8qgsm.jpg\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755556359818,\"title\":\"Fridge doors\",\"description\":\"How many doors\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"1 door\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755556338234-9ftn76iow96.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-18 20:48:13', '2025-08-18 22:44:50', 0, 1, '[{\"id\": 1, \"options\": [{\"id\": 1, \"text\": \"yes\"}, {\"id\": 2, \"text\": \"No\", \"image\": \"\"}], \"question\": \"Do you have pets?\", \"required\": false, \"description\": \"adsfsadf\", \"questionType\": \"dropdown\", \"selectionType\": \"single\"}, {\"id\": 2, \"options\": [{\"id\": 1, \"text\": \"Cats\"}, {\"id\": 2, \"text\": \"Dogs\", \"image\": \"\"}, {\"id\": 3, \"text\": \"Bird\", \"image\": \"\"}], \"question\": \"Do you have more pets?\", \"required\": false, \"description\": \"adsfsadf\", \"questionType\": \"dropdown\", \"selectionType\": \"multi\"}, {\"id\": 3, \"options\": [{\"id\": 3, \"text\": \"Cats\", \"image\": \"\"}, {\"id\": 4, \"text\": \"#00ff00\", \"image\": \"\"}, {\"id\": 5, \"text\": \"#6b2424\", \"image\": \"\"}, {\"id\": 6, \"text\": \"#FFD700\", \"image\": \"\"}], \"question\": \"What color are you pets?\", \"required\": false, \"description\": \"adsfsadf\", \"questionType\": \"color_choice\", \"selectionType\": \"multi\"}, {\"id\": 4, \"options\": [{\"id\": 3, \"text\": \"Cats\", \"image\": \"\"}, {\"id\": 4, \"text\": \"#00ff00\", \"image\": \"\"}, {\"id\": 5, \"text\": \"#6b2424\", \"image\": \"\"}, {\"id\": 6, \"text\": \"#FFD700\", \"image\": \"\"}], \"question\": \"Put your image here\", \"required\": false, \"description\": \"adsfsadf\", \"questionType\": \"image_upload\", \"selectionType\": \"multi\"}, {\"id\": 5, \"options\": [{\"id\": 3, \"text\": \"Cats\", \"image\": \"\"}, {\"id\": 4, \"text\": \"#00ff00\", \"image\": \"\"}, {\"id\": 5, \"text\": \"#6b2424\", \"image\": \"\"}, {\"id\": 6, \"text\": \"#FFD700\", \"image\": \"\"}], \"question\": \"It\'s a short answer question\", \"required\": false, \"description\": \"adsfsadf\", \"questionType\": \"short_text\", \"selectionType\": \"multi\"}, {\"id\": 6, \"options\": [{\"id\": 3, \"text\": \"Cats\", \"image\": \"\"}, {\"id\": 4, \"text\": \"#00ff00\", \"image\": \"\"}, {\"id\": 5, \"text\": \"#6b2424\", \"image\": \"\"}, {\"id\": 6, \"text\": \"#FFD700\", \"image\": \"\"}], \"question\": \"It\'s a long answer question\", \"required\": false, \"description\": \"adsfsadf\", \"questionType\": \"long_text\", \"selectionType\": \"multi\"}]', NULL),
(46, 5, 'Test service 1', 'asdf', 21.96, 30, '', 'https://zenbookapi.now2code.online/uploads/service-image-1755557409994-2zyzfv7d5r6.png', '[]', '2025-08-18 22:46:54', '2025-08-18 22:51:24', 0, 1, '[]', NULL),
(47, 5, 'test category', 'adfasdf', 22.00, 27, 'Test category', 'https://zenbookapi.now2code.online/uploads/service-image-1755557323761-mdm0qdms22f.jpg', '[]', '2025-08-18 22:48:43', '2025-08-21 19:45:15', 0, 1, NULL, NULL),
(48, 5, 'test service', 'sadf', 22.00, 30, '', 'https://zenbookapi.now2code.online/uploads/service-image-1755557370845-om5icsl6gz.webp', '[]', '2025-08-18 22:49:31', '2025-08-19 16:28:28', 0, 1, NULL, NULL),
(49, 5, '25 test service', 'asdf', 33.00, 30, 'Test category', NULL, '[]', '2025-08-18 23:12:46', '2025-08-19 15:02:29', 0, 1, NULL, 23),
(50, 5, 'Test all the services modifiers', 'sadfdsaf', 22.00, 29, '', 'https://zenbookapi.now2code.online/uploads/service-image-1755621098399-qaynsjj5lr.png', '[{\"id\":1755621994313,\"title\":\"Modifier Single select\",\"description\":\"sadf\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"asdf\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755621979394-iox7cll2ng.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"sdf\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755621989562-7a2vwaer5be.webp\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755622044691,\"title\":\"Multiselect\",\"description\":\"asdf\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"1 option\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"2 option\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":3,\"label\":\"\",\"price\":1,\"duration\":0,\"description\":\"2 option\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755622234707,\"title\":\"Quontaty select\",\"description\":\"asdgdsa\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":1,\"duration\":0,\"description\":\"1 option\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"2 option\",\"image\":\"https://zenbookapi.now2code.online/uploads/modifier-image-1755622229917-9owupdhxpdf.png\",\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-19 16:31:27', '2025-08-19 18:19:42', 0, 1, '[{\"id\": 1, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Dropdoen question single\", \"required\": false, \"description\": \"dfsadsafasdf\", \"questionType\": \"dropdown\", \"selectionType\": \"single\"}, {\"id\": 2, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Dropdoen question Multi\", \"required\": false, \"description\": \"dfsadsafasdf\", \"questionType\": \"dropdown\", \"selectionType\": \"multi\"}, {\"id\": 3, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Multiple choice\", \"required\": false, \"description\": \"dfsadsafasdf\", \"questionType\": \"multiple_choice\", \"selectionType\": \"multi\"}, {\"id\": 4, \"options\": [{\"id\": 1, \"text\": \"OPtion 1\"}, {\"id\": 2, \"text\": \"Option 2\", \"image\": \"\"}], \"question\": \"Single Select\", \"required\": false, \"description\": \"asdfdsaf\", \"questionType\": \"multiple_choice\", \"selectionType\": \"single\"}, {\"id\": 5, \"options\": [{\"id\": 1, \"text\": \"options 1\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755627556310-bqwlazp49mn.png\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755627569716-rtck8lcq13t.jpg\"}], \"question\": \"Single select\", \"required\": false, \"description\": \"sadfdsaf\", \"questionType\": \"picture_choice\", \"selectionType\": \"single\"}]', NULL),
(52, 3, 'Plumbing', '', 0.00, 30, '', NULL, '[]', '2025-08-19 16:50:57', '2025-08-19 16:50:57', 0, 1, NULL, NULL),
(53, 3, 'Office Cleaning', 'Cleaning of Office', 40.00, 90, '', NULL, '[{\"id\":1755622444983,\"title\":\"How many offices\",\"description\":\"quantity\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":1,\"duration\":30,\"description\":\"2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":30,\"duration\":60,\"description\":\"3\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-19 16:51:56', '2025-08-20 21:35:16', 0, 1, '[{\"id\": 1, \"options\": [{\"id\": 1, \"text\": \"small\"}, {\"id\": 2, \"text\": \"Medium\", \"image\": \"\"}, {\"id\": 3, \"text\": \"Big\", \"image\": \"\"}, {\"id\": 4, \"text\": \"Very big\", \"image\": \"\"}], \"question\": \"How big is/are the offices?\", \"required\": false, \"description\": \"\", \"questionType\": \"dropdown\", \"selectionType\": \"single\"}]', NULL),
(54, 3, 'stripe', '', 0.00, 30, 'Moving', NULL, '[]', '2025-08-21 12:52:56', '2025-08-21 12:53:20', 0, 1, NULL, NULL),
(55, 3, 'Gas cylinder cleaning', '', 0.00, 30, '', NULL, '[]', '2025-08-21 13:00:38', '2025-08-21 13:00:38', 0, 1, NULL, NULL),
(56, 5, 'Service with no data', '', 0.00, 30, '', NULL, '[{\"id\":1755805742859,\"title\":\"Opti0ons and reload\",\"description\":\"\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"options 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755805891169,\"title\":\"Multiselect\",\"description\":\"\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"options 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755805928820,\"title\":\"Quantity select\",\"description\":\"asdfdsa\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"Option 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":3,\"label\":\"\",\"price\":0,\"duration\":0,\"description\":\"Option 3\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-21 19:45:33', '2025-08-21 19:52:20', 0, 1, '[]', NULL),
(57, 5, 'Price testing service', '', 10.00, 30, '', NULL, '[{\"id\":1755806962550,\"title\":\"Test single select price\",\"description\":\"fsa\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":5,\"duration\":5,\"description\":\"option 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":10,\"duration\":10,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755807003253,\"title\":\"Price modifier test\",\"description\":\"\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":3,\"duration\":3,\"description\":\"Option 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":4,\"duration\":4,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-21 20:08:41', '2025-08-21 20:10:14', 0, 1, '[]', NULL),
(58, 5, 'Services menu', '', 0.00, 30, '', NULL, '[]', '2025-08-21 20:42:13', '2025-08-21 20:42:13', 0, 1, NULL, NULL),
(59, 5, 'Test all the services modifiers and questions', 'afsad', 100.00, 30, '', NULL, '[{\"id\":1755821402874,\"title\":\"Singles Select\",\"description\":\"asdf\",\"selectionType\":\"single\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":0,\"description\":\"option 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":0,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755821445990,\"title\":\"Multiselect\",\"description\":\"adsfdsaf\",\"selectionType\":\"multi\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":10,\"duration\":0,\"description\":\"option 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":2,\"duration\":0,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]},{\"id\":1755821486510,\"title\":\"Quantity select\",\"description\":\"asdf\",\"selectionType\":\"quantity\",\"required\":false,\"options\":[{\"id\":1,\"label\":\"\",\"price\":9,\"duration\":0,\"description\":\"option 1\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false},{\"id\":2,\"label\":\"\",\"price\":20,\"duration\":0,\"description\":\"option 2\",\"image\":null,\"allowCustomerNotes\":false,\"convertToServiceRequest\":false}]}]', '2025-08-22 00:09:21', '2025-08-22 00:15:56', 0, 1, '[{\"id\": 1, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Single Select question\", \"required\": false, \"description\": \"\", \"questionType\": \"dropdown\", \"selectionType\": \"single\"}, {\"id\": 2, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Multi Select question\", \"required\": false, \"description\": \"\", \"questionType\": \"dropdown\", \"selectionType\": \"multi\"}, {\"id\": 3, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Multi Choice question\", \"required\": false, \"description\": \"\", \"questionType\": \"multiple_choice\", \"selectionType\": \"multi\"}, {\"id\": 4, \"options\": [{\"id\": 1, \"text\": \"option 1\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"\"}], \"question\": \"Single Choice question\", \"required\": false, \"description\": \"\", \"questionType\": \"multiple_choice\", \"selectionType\": \"single\"}, {\"id\": 5, \"options\": [{\"id\": 1, \"text\": \"option 1\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755821711371-y1ofmnqdg1i.png\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755821714932-thkyppk9r7a.webp\"}], \"question\": \"Picture Choice question\", \"required\": false, \"description\": \"\", \"questionType\": \"picture_choice\", \"selectionType\": \"single\"}, {\"id\": 6, \"options\": [{\"id\": 1, \"text\": \"option 1\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755821711371-y1ofmnqdg1i.png\"}, {\"id\": 2, \"text\": \"option 2\", \"image\": \"https://zenbookapi.now2code.online/uploads/modifier-image-1755821714932-thkyppk9r7a.webp\"}], \"question\": \"Picture Choice question multi\", \"required\": false, \"description\": \"\", \"questionType\": \"picture_choice\", \"selectionType\": \"multi\"}]', NULL),
(60, 3, 'higher ground', NULL, 0.00, 30, NULL, NULL, '\"[]\"', '2025-08-22 18:46:37', '2025-08-22 18:46:37', 0, 1, NULL, NULL),
(61, 3, 'TV ding', NULL, 0.00, 30, NULL, NULL, '\"[{\\\"id\\\":1755889701201,\\\"title\\\":\\\"Gome\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false}]}]\"', '2025-08-22 19:08:02', '2025-08-22 19:08:28', 0, 1, '\"[]\"', NULL),
(62, 3, 'Dispatch', NULL, 40.00, 90, 'Cleaning', NULL, NULL, '2025-08-23 21:43:32', '2025-08-24 01:50:58', 0, 1, NULL, NULL),
(63, 5, 'Service test August 23', NULL, 0.00, 30, NULL, NULL, '\"[]\"', '2025-08-23 22:26:53', '2025-08-23 22:26:53', 0, 1, NULL, NULL),
(64, 5, 'Service test August 23', NULL, 0.00, 30, NULL, NULL, '\"[]\"', '2025-08-23 22:27:25', '2025-08-23 22:27:25', 0, 1, NULL, NULL),
(65, 5, 'asdfdsaf', NULL, 0.00, 30, NULL, NULL, '\"[]\"', '2025-08-23 22:30:22', '2025-08-23 22:30:22', 0, 1, NULL, NULL),
(66, 5, 'one more test', NULL, 0.00, 30, NULL, NULL, '\"[{\\\"id\\\":1755988341396,\\\"title\\\":\\\"Single select modifier\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"option 1\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false},{\\\"id\\\":2,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"option 2\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false}]},{\\\"id\\\":1755988369471,\\\"title\\\":\\\"Multi select modifier\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"multi\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"option 1\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false},{\\\"id\\\":2,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"option 2\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false}]},{\\\"id\\\":1755988450957,\\\"title\\\":\\\"Quontaty select modifier\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"quantity\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"option 1\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false},{\\\"id\\\":2,\\\"label\\\":\\\"\\\",\\\"price\\\":0,\\\"duration\\\":0,\\\"description\\\":\\\"Option 2\\\",\\\"image\\\":null,\\\"allowCustomerNotes\\\":false,\\\"convertToServiceRequest\\\":false}]}]\"', '2025-08-23 22:32:04', '2025-08-23 22:39:41', 0, 1, '\"[{\\\"id\\\":1,\\\"questionType\\\":\\\"dropdown\\\",\\\"question\\\":\\\"Single fropdown question\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"\\\"}]},{\\\"id\\\":2,\\\"questionType\\\":\\\"dropdown\\\",\\\"question\\\":\\\"Multiple dropdown question\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"multi\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"\\\"}]},{\\\"id\\\":3,\\\"questionType\\\":\\\"multiple_choice\\\",\\\"question\\\":\\\"Multiple choice multi\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"multi\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"\\\"}]},{\\\"id\\\":4,\\\"questionType\\\":\\\"multiple_choice\\\",\\\"question\\\":\\\"Multiple choice single\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"\\\"}]},{\\\"id\\\":5,\\\"questionType\\\":\\\"picture_choice\\\",\\\"question\\\":\\\"Multiple choice single\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988604480-dsmox6p4c9h.png\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988608752-fsq57m2ozli.png\\\"}]},{\\\"id\\\":6,\\\"questionType\\\":\\\"short_text\\\",\\\"question\\\":\\\"Short text\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988604480-dsmox6p4c9h.png\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988608752-fsq57m2ozli.png\\\"}]},{\\\"id\\\":7,\\\"questionType\\\":\\\"long_text\\\",\\\"question\\\":\\\"Long ttext\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"option 1\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988604480-dsmox6p4c9h.png\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988608752-fsq57m2ozli.png\\\"}]},{\\\"id\\\":8,\\\"questionType\\\":\\\"color_choice\\\",\\\"question\\\":\\\"Long ttext\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"single\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"#32cd32\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988604480-dsmox6p4c9h.png\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988608752-fsq57m2ozli.png\\\"},{\\\"id\\\":3,\\\"text\\\":\\\"#4169E1\\\",\\\"image\\\":\\\"\\\"}]},{\\\"id\\\":9,\\\"questionType\\\":\\\"color_choice\\\",\\\"question\\\":\\\"Long ttext\\\",\\\"description\\\":\\\"\\\",\\\"selectionType\\\":\\\"multi\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"#32cd32\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988604480-dsmox6p4c9h.png\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988608752-fsq57m2ozli.png\\\"},{\\\"id\\\":3,\\\"text\\\":\\\"#4169E1\\\",\\\"image\\\":\\\"\\\"}]},{\\\"id\\\":10,\\\"questionType\\\":\\\"image_upload\\\",\\\"question\\\":\\\"Image upload\\\",\\\"description\\\":\\\"Upload the image\\\",\\\"selectionType\\\":\\\"multi\\\",\\\"required\\\":false,\\\"options\\\":[{\\\"id\\\":1,\\\"text\\\":\\\"#32cd32\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988604480-dsmox6p4c9h.png\\\"},{\\\"id\\\":2,\\\"text\\\":\\\"option 2\\\",\\\"image\\\":\\\"https://zenbookapi.now2code.online/uploads/modifier-image-1755988608752-fsq57m2ozli.png\\\"},{\\\"id\\\":3,\\\"text\\\":\\\"#4169E1\\\",\\\"image\\\":\\\"\\\"}]}]\"', NULL);

-- --------------------------------------------------------

--
-- Table structure for table `service_availability`
--

CREATE TABLE `service_availability` (
  `id` int NOT NULL,
  `service_id` int NOT NULL,
  `user_id` int NOT NULL,
  `availability_type` enum('default','custom') COLLATE utf8mb4_general_ci DEFAULT 'default',
  `business_hours_override` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `timeslot_template_id` int DEFAULT NULL,
  `minimum_booking_notice` int DEFAULT '0',
  `maximum_booking_advance` int DEFAULT '525600',
  `booking_interval` int DEFAULT '30',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

--
-- Dumping data for table `service_availability`
--

INSERT INTO `service_availability` (`id`, `service_id`, `user_id`, `availability_type`, `business_hours_override`, `timeslot_template_id`, `minimum_booking_notice`, `maximum_booking_advance`, `booking_interval`, `created_at`, `updated_at`) VALUES
(1, 5, 1, 'custom', NULL, NULL, 0, 525600, 15, '2025-07-15 01:31:38', '2025-07-15 01:31:38'),
(2, 6, 3, 'custom', NULL, NULL, 300, 525600, 30, '2025-07-16 02:08:33', '2025-07-16 02:08:33');

-- --------------------------------------------------------

--
-- Table structure for table `service_categories`
--

CREATE TABLE `service_categories` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `color` varchar(7) COLLATE utf8mb4_general_ci DEFAULT '#3B82F6',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `service_categories`
--

INSERT INTO `service_categories` (`id`, `user_id`, `name`, `description`, `color`, `created_at`, `updated_at`) VALUES
(1, 2, 'Cleaning', 'General cleaning services', '#3B82F6', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(2, 1, 'Cleaning', 'General cleaning services', '#3B82F6', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(3, 4, 'Cleaning', 'General cleaning services', '#3B82F6', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(4, 6, 'Cleaning', 'General cleaning services', '#3B82F6', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(5, 10, 'Cleaning', 'General cleaning services', '#3B82F6', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(6, 3, 'Cleaning', 'General cleaning services', '#3B82F6', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(8, 3, 'Maintenance', 'Maintenance and repair services', '#10B981', '2025-08-17 20:57:24', '2025-08-17 20:57:24'),
(10, 1, 'Repair', 'Repair services', '#3B82F6', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(11, 7, 'Removal', 'Removal services', '#3B82F6', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(12, 5, 'Celaning', 'Celaning services', '#3B82F6', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(13, 3, 'Moving', 'Moving services', '#3B82F6', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(14, 5, 'Applience', 'Applience services', '#3B82F6', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(17, 8, 'General', 'General services', '#6B7280', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(18, 9, 'General', 'General services', '#6B7280', '2025-08-17 21:15:01', '2025-08-17 21:15:01'),
(22, 3, 'driving', 'driving services', '#3B82F6', '2025-08-18 08:13:13', '2025-08-18 08:13:13'),
(23, 5, 'Fridge repair', 'Fridge repair services', '#3B82F6', '2025-08-18 12:24:14', '2025-08-18 12:24:14'),
(24, 5, 'Test category', 'Test category services', '#3B82F6', '2025-08-18 22:46:11', '2025-08-18 22:46:11'),
(29, 3, 'washing', 'washing services', '#3B82F6', '2025-08-20 21:34:52', '2025-08-20 21:34:52');

-- --------------------------------------------------------

--
-- Table structure for table `service_scheduling_rules`
--

CREATE TABLE `service_scheduling_rules` (
  `id` int NOT NULL,
  `service_id` int NOT NULL,
  `rule_type` enum('blackout','special_hours','capacity_limit') COLLATE utf8mb4_general_ci NOT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `start_time` time DEFAULT NULL,
  `end_time` time DEFAULT NULL,
  `days_of_week` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `capacity_limit` int DEFAULT NULL,
  `reason` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

-- --------------------------------------------------------

--
-- Table structure for table `service_timeslot_templates`
--

CREATE TABLE `service_timeslot_templates` (
  `id` int NOT NULL,
  `service_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `timeslots` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

-- --------------------------------------------------------

--
-- Table structure for table `team_members`
--

CREATE TABLE `team_members` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `phone` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `role` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `username` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `is_verified` tinyint(1) DEFAULT '0',
  `verification_token` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reset_token` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reset_token_expires` timestamp NULL DEFAULT NULL,
  `last_login` timestamp NULL DEFAULT NULL,
  `skills` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `hourly_rate` decimal(10,2) DEFAULT NULL,
  `availability` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `profile_picture` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('active','inactive','on_leave','invited') COLLATE utf8mb4_general_ci DEFAULT 'active',
  `permissions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `location` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `city` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `state` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `zip_code` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `is_service_provider` tinyint(1) DEFAULT '1',
  `territories` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `invitation_token` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `invitation_expires` timestamp NULL DEFAULT NULL,
  `settings` json DEFAULT NULL
) ;

--
-- Dumping data for table `team_members`
--

INSERT INTO `team_members` (`id`, `user_id`, `first_name`, `last_name`, `email`, `phone`, `role`, `username`, `password`, `is_active`, `is_verified`, `verification_token`, `reset_token`, `reset_token_expires`, `last_login`, `skills`, `hourly_rate`, `availability`, `profile_picture`, `status`, `permissions`, `created_at`, `updated_at`, `location`, `city`, `state`, `zip_code`, `is_service_provider`, `territories`, `invitation_token`, `invitation_expires`, `settings`) VALUES
(2, 3, 'Dave', 'Shaw', 'daveshaw@gmail.com', '+09030844572', 'Manager', 'Daver', '$2a$10$OHyes7dtQvASL4.daOlzbuNsLRPg7Cc/ZuUDfiuh7.SOpnJ3wE4zC', 1, 0, NULL, NULL, NULL, '2025-07-25 20:50:21', '\"[]\"', 40.00, '\"{\\\"workingHours\\\":{\\\"sunday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"},\\\"monday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"tuesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"wednesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"thursday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"friday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"saturday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"}},\\\"customAvailability\\\":[]}\"', NULL, 'inactive', '\"\\\"\\\\\\\"\\\\\\\\\\\\\\\"{\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"isServiceProvider\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"canEditAvailability\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"limitJobsPerDay\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":false,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"canAutoAssign\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"canClaimJobs\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"emailNotifications\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"smsNotifications\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true}\\\\\\\\\\\\\\\"\\\\\\\"\\\"\"', '2025-07-25 20:29:26', '2025-08-01 13:10:40', 'chelsea', '', '', NULL, 1, '\"[1]\"', NULL, NULL, '{\"canClaimJobs\": true, \"canAutoAssign\": true, \"limitJobsPerDay\": false, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": false, \"canEditAvailability\": true}'),
(3, 3, 'Turique ', 'George', 'tg@gmail.com', '(988) 623-5645', 'Manager ', 'Tgeorge', '$2a$10$esPH9aqp2O3L.i8Ze9oz7ObbWyargBB.e9k.qsPIB54YHB81ExuYy', 1, 0, NULL, NULL, NULL, '2025-07-26 02:03:41', '\"[\\\"Flushing\\\"]\"', 40.00, '\"{\\\"workingHours\\\":{\\\"sunday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"},\\\"monday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"tuesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"wednesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"thursday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"friday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"saturday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"}},\\\"customAvailability\\\":[]}\"', NULL, 'active', '\"\\\"\\\\\\\"\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"{\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"isServiceProvider\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"canEditAvailability\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"limitJobsPerDay\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":false,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"canAutoAssign\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"canClaimJobs\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"emailNotifications\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":true,\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"smsNotifications\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\":false}\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\"\\\\\\\"\\\"\"', '2025-07-25 22:17:23', '2025-08-06 14:59:14', 'Manchester Expressway, Columbus, GA, USA', 'Columbus', 'GA', NULL, 1, '\"[1]\"', NULL, NULL, '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(4, 7, 'Adeniyi', 'Adejuw', 'adeniyiadejuwon0@gmail.com', '(234) 737-0125', 'supervisor', 'bbd', '$2a$10$OU4H/34cs8E9s5ALN8ov/uZ4OiE0ZZMmAAmyhN40f.Yix9rjg7wKe', 1, 0, NULL, NULL, NULL, NULL, '[\"Grooo\"]', 40.00, '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"available\":false}}', NULL, 'active', '{\"viewCustomerNotes\":true,\"modifyJobStatus\":true,\"editJobDetails\":true,\"rescheduleJobs\":true,\"editAvailability\":true}', '2025-07-26 21:08:37', '2025-07-31 01:04:53', 'Chelsea Avenue, Memphis, TN, USA', 'Memphis', 'TN', '', 1, '[3]', NULL, NULL, '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(5, 7, 'Benson', 'Cena', 'Bcena@gmail.com', '(944) 011-7782', 'Manager', 'BCena', '$2a$10$RYqgZZMc3WYGlCnMkUAhbOfveS6LC7968waeOGIuAGFwp4iAFCBoW', 1, 0, NULL, NULL, NULL, NULL, '[\"cleaning\"]', 25.00, NULL, NULL, 'inactive', NULL, '2025-07-26 21:32:57', '2025-07-31 01:04:53', NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(6, 5, 'Georgiy', 'Sayapin', 'sayapingeorge@gmail.com', '(248) 346-2681', 'Cleaner', 'test_member', '$2a$10$ZTDA6Z1hIzEgu1/VM3o/5uePhfdBCDz2NnDucAKj8Mtposut/hKrC', 1, 0, NULL, NULL, NULL, NULL, '\"[]\"', 20.00, '\"{\\\"workingHours\\\":{\\\"sunday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"},\\\"monday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"tuesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"wednesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"thursday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"friday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"saturday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"}},\\\"customAvailability\\\":[]}\"', NULL, 'active', '\"\\\"{\\\\\\\"isServiceProvider\\\\\\\":true,\\\\\\\"canEditAvailability\\\\\\\":true,\\\\\\\"limitJobsPerDay\\\\\\\":false,\\\\\\\"canAutoAssign\\\\\\\":true,\\\\\\\"canClaimJobs\\\\\\\":true,\\\\\\\"emailNotifications\\\\\\\":true,\\\\\\\"smsNotifications\\\\\\\":false}\\\"\"', '2025-07-27 19:05:53', '2025-08-11 22:06:45', '5631 Raven Ct.', 'Bloomfield Hills', 'MI', NULL, 1, '\"[4]\"', NULL, NULL, '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(7, 7, 'Adeniyi', 'Adejuwon', 'wevbest@gmail.com', '(810) 737-0125', 'worker', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '{\"viewCustomerNotes\":true,\"modifyJobStatus\":true,\"editJobDetails\":true,\"rescheduleJobs\":true,\"editAvailability\":true}', '2025-07-27 23:35:55', '2025-07-31 01:04:53', '6 opposite school gate, iworoko rd, osekita', NULL, NULL, NULL, 1, '[3]', 'c7d4f978e6461c822d92f7c7e095909fe8c0d7d23e3c8212c0565d66e9b2d6b0', '2025-08-04 00:37:37', '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(8, 9, 'John', 'Mark', 'jm@gmail.com', '(343) 434-3434', 'worker', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '{\"viewCustomerNotes\":true,\"modifyJobStatus\":true,\"editJobDetails\":true,\"rescheduleJobs\":true,\"editAvailability\":true}', '2025-07-28 00:56:41', '2025-07-31 01:04:53', 'Chelsea Avenue, Memphis, TN, USA', 'Memphis', 'TN', NULL, 1, '[]', 'ca61f1adc9092ad1b39fd6f2b2a60f79655909b67a6863e542a0a2e072423b16', NULL, '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(9, 5, 'Georgiy', 'Sayapin2', 'info@spotless.homes', '(248) 346-2681', 'supervisor', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '{\"viewCustomerNotes\":true,\"modifyJobStatus\":true,\"editJobDetails\":true,\"rescheduleJobs\":true,\"editAvailability\":true}', '2025-07-29 23:14:10', '2025-08-11 22:16:27', '5631 Raven Ct, Bloomfield Hills, MI, USA', 'Bloomfield Hills', 'MI', '48301', 1, '[]', '6a091ea22b93dd70958862096cb4d3610a75147dc6beba404587f3cda17bed86', '2025-08-18 22:16:28', '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(10, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon0@gmail.com', '(944) 589-1023', 'worker', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, '\"{\\\"workingHours\\\":{\\\"sunday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"},\\\"monday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\",\\\"timeSlots\\\":[{\\\"id\\\":1753921267986,\\\"start\\\":\\\"09:00\\\",\\\"end\\\":\\\"17:00\\\",\\\"enabled\\\":true}]},\\\"tuesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"wednesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"thursday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"friday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"saturday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"}},\\\"customAvailability\\\":[]}\"', NULL, 'invited', '{\"viewCustomerNotes\":true,\"modifyJobStatus\":true,\"editJobDetails\":true,\"rescheduleJobs\":true,\"editAvailability\":true}', '2025-07-31 00:19:30', '2025-08-22 19:07:37', '6 opposite school gate, iworoko rd, osekita', NULL, NULL, NULL, 1, '[1]', '3ba887085ee0e844ee780ac7d6cbc3e5f561639a290808ffe8806191bd971793', '2025-08-29 19:07:37', '{\"role\": \"service_provider\", \"permissions\": {\"editJobs\": false, \"createJobs\": false, \"deleteJobs\": false, \"manageTeam\": false, \"viewReports\": false, \"manageSettings\": false}, \"smsNotifications\": false, \"isServiceProvider\": true, \"emailNotifications\": true}'),
(11, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon05@gmail.com', '08107370125', 'Technician', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, '\"[{\\\"name\\\":\\\"Barbing\\\",\\\"level\\\":\\\"Intermediate\\\"}]\"', NULL, '\"{\\\"workingHours\\\":{\\\"sunday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"},\\\"monday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"tuesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"wednesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"thursday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"friday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"saturday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"}},\\\"customAvailability\\\":[]}\"', NULL, 'inactive', '\"\\\"{\\\\\\\"isServiceProvider\\\\\\\":true,\\\\\\\"canEditAvailability\\\\\\\":true,\\\\\\\"limitJobsPerDay\\\\\\\":false,\\\\\\\"canAutoAssign\\\\\\\":true,\\\\\\\"canClaimJobs\\\\\\\":true,\\\\\\\"emailNotifications\\\\\\\":true,\\\\\\\"smsNotifications\\\\\\\":true}\\\"\"', '2025-08-02 21:45:13', '2025-08-14 00:21:48', 'Chelton Road, Colorado Springs, CO, USA', 'Colorado Springs', 'CO', '668123', 1, '\"[1]\"', '3554a1613effcf1b4f4844899d6b935d930b856e63e792a55877d5f1290755ed', NULL, NULL),
(12, 3, 'Benson', 'Kuhmar', 'bKuhmar@gmail.com', '9446339012', 'Manager', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, '\"[{\\\"name\\\":\\\"Barbing\\\",\\\"level\\\":\\\"Advanced\\\"}]\"', NULL, '\"{\\\"workingHours\\\":{\\\"sunday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"},\\\"monday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"tuesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"wednesday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"thursday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"friday\\\":{\\\"available\\\":true,\\\"hours\\\":\\\"9:00 AM - 6:00 PM\\\"},\\\"saturday\\\":{\\\"available\\\":false,\\\"hours\\\":\\\"\\\"}},\\\"customAvailability\\\":[]}\"', NULL, 'invited', '\"\\\"{\\\\\\\"isServiceProvider\\\\\\\":true,\\\\\\\"canEditAvailability\\\\\\\":true,\\\\\\\"limitJobsPerDay\\\\\\\":false,\\\\\\\"canAutoAssign\\\\\\\":true,\\\\\\\"canClaimJobs\\\\\\\":true,\\\\\\\"emailNotifications\\\\\\\":true,\\\\\\\"smsNotifications\\\\\\\":true}\\\"\"', '2025-08-03 01:20:50', '2025-08-03 01:21:37', 'Chelsea Avenue, Memphis, TN, USA', 'Memphis', 'TN', '400912', 1, '\"[1]\"', '080863aced66b11495a23462aa5eff3a6e2b98bf8c2082619618e1535b07258e', NULL, NULL),
(13, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon077@gmail.com', '08107370125', 'Manager', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-06 15:00:41', '2025-08-06 15:00:41', '6 opposite school gate, iworoko rd, osekita', 'Iworoko-Ekiti', 'Ekiti State', '362103', 1, '\"[1]\"', 'c56015014df297b02638cf437ab76ed1b354956edac6ec681a874cc15a601b1f', NULL, NULL),
(14, 5, 'Georgiy info', 'Sayapin', 'prorabserv@gmail.com', '2483462681', 'Technician', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-11 22:16:05', '2025-08-11 22:16:05', '5631 Raven Ct.', 'Bloomfield Hills', 'MI', '48301', 1, '\"[]\"', 'fcf8e0b3125ad1db765329be4599a4dfe9f92cfe29d7e564124f30ed0565239a', NULL, NULL),
(15, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon440@gmail.com', '08107370125', 'Technician', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-22 18:45:29', '2025-08-22 18:45:29', '6 opposite school gate, iworoko rd, osekita', 'Iworoko-Ekiti', 'Ekiti State', '362103', 1, '\"[]\"', 'e05dacf417c27a9947c557b3c314c5654e8c26118d8ed8432b1e45fe5e127be9', NULL, NULL),
(16, 3, 'Adeniyi', 'Adejuwon', 'adeniyiadejuwon023@gmail.com', '08107370125', 'Helper', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-23 14:59:10', '2025-08-23 14:59:10', '6 opposite school gate, iworoko rd, osekita', 'Iworoko-Ekiti', 'Select State', '362103', 1, '\"[]\"', '96f6da8a405c6f8560b710eeab362f19b81833d7660606f70e2ea82ba039ec75', NULL, NULL),
(17, 3, 'Dwayne', 'Johnson', 'dwaynejohnson@gmail.com', '08107370125', 'Technician', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-23 17:00:21', '2025-08-23 17:00:21', 'Chelsea Avenue, Memphis, TN, USA', 'Memphis', 'TN', '55690', 1, '\"[5]\"', '40bdd17f4ee5de73f34000d31cb480fdb32bb1121aea28f8717983e07c045c5b', NULL, NULL),
(18, 3, 'Johnson', 'Traore', 'Jtrao@gmail.com', '9118763221', 'Manager', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-23 21:48:46', '2025-08-23 21:48:46', 'Cherohala Skyway, Robbinsville, NC, USA', 'Robbinsville', 'NC', '677190', 1, '\"[1]\"', 'cee4bb71166a46fe8f65280b6ac6b9fb9f50e355f65f353a4c4abba9cb3a09dd', NULL, NULL),
(19, 5, 'Georgiy', 'Sayapin', 'georgiysayapin@gmail.com', '2483462681', 'Manager', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-23 22:20:16', '2025-08-23 22:20:16', '5631 Raven Ct.', 'Bloomfield Hills', 'MI', '48301', 1, '\"[2]\"', 'e28beabd84f1e1421f93b9f8150392653c8b002c35a4030eece00b3fd05fbcf6', NULL, NULL),
(20, 5, 'Georgiy', 'Sayapin', 'spotlesshomes@gmail.com', '2483462681', 'Technician', NULL, NULL, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'invited', '\"{\\\"isServiceProvider\\\":true,\\\"canEditAvailability\\\":true,\\\"limitJobsPerDay\\\":false,\\\"canAutoAssign\\\":true,\\\"canClaimJobs\\\":true,\\\"emailNotifications\\\":true,\\\"smsNotifications\\\":true}\"', '2025-08-23 22:42:32', '2025-08-23 22:42:32', '5631 Raven Ct.', 'Bloomfield Hills', 'MI', '48301', 1, '\"[]\"', '1135396f06da1646f9b1378d170d5c47009ce00092b211c778d7c0fe9848daa4', NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `team_member_job_assignments`
--

CREATE TABLE `team_member_job_assignments` (
  `id` int NOT NULL,
  `team_member_id` int NOT NULL,
  `job_id` int NOT NULL,
  `assigned_by` int NOT NULL,
  `assigned_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` enum('assigned','accepted','started','completed','declined') COLLATE utf8mb4_general_ci DEFAULT 'assigned',
  `notes` text COLLATE utf8mb4_general_ci,
  `started_at` timestamp NULL DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `rating` int DEFAULT NULL,
  `feedback` text COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `team_member_notifications`
--

CREATE TABLE `team_member_notifications` (
  `id` int NOT NULL,
  `team_member_id` int NOT NULL,
  `type` enum('job_assigned','job_reminder','job_completed','system','payment') COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci NOT NULL,
  `data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `is_read` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ;

-- --------------------------------------------------------

--
-- Table structure for table `team_member_sessions`
--

CREATE TABLE `team_member_sessions` (
  `id` int NOT NULL,
  `team_member_id` int NOT NULL,
  `session_token` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `device_info` text COLLATE utf8mb4_general_ci,
  `ip_address` varchar(45) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `territories`
--

CREATE TABLE `territories` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `description` text COLLATE utf8mb4_general_ci,
  `zip_codes` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `location` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'City, State, Country',
  `radius_miles` decimal(5,2) DEFAULT '25.00' COMMENT 'Service radius in miles',
  `timezone` varchar(50) COLLATE utf8mb4_general_ci DEFAULT 'America/New_York' COMMENT 'Territory timezone',
  `status` enum('active','inactive','archived') COLLATE utf8mb4_general_ci DEFAULT 'active' COMMENT 'Territory status',
  `business_hours` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Territory-specific business hours',
  `team_members` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Array of team member IDs assigned to this territory',
  `services` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Array of service IDs available in this territory',
  `pricing_multiplier` decimal(3,2) DEFAULT '1.00' COMMENT 'Price multiplier for this territory'
) ;

--
-- Dumping data for table `territories`
--

INSERT INTO `territories` (`id`, `user_id`, `name`, `description`, `zip_codes`, `created_at`, `updated_at`, `location`, `radius_miles`, `timezone`, `status`, `business_hours`, `team_members`, `services`, `pricing_multiplier`) VALUES
(1, 3, 'Just web', '', '[]', '2025-07-18 22:07:49', '2025-08-11 00:54:17', 'Chelsea Avenue, Memphis, TN, USA', 25.00, 'America/New_York', 'active', '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":false},\"saturday\":{\"start\":\"09:00\",\"end\":\"15:00\",\"enabled\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"12:00\",\"enabled\":false}}', '[4,3]', '[6]', 2.00),
(2, 5, 'Tampa', 'Tampa territory', '[]', '2025-07-27 00:24:19', '2025-07-27 00:24:19', 'Tampa', 30.00, 'America/Los_Angeles', 'active', '{}', '[]', '[18,17]', 1.10),
(3, 7, 'Sledge area', 'Based on true life story', '[\"75048\"]', '2025-07-27 23:26:40', '2025-07-27 23:26:40', 'Chene Drive, Sachse, TX, USA', 25.00, 'America/New_York', 'active', '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"15:00\",\"enabled\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"12:00\",\"enabled\":false}}', '[]', '[]', 1.00),
(4, 5, 'St Petersburg', 'second location', '[\"33716\",\"33524\"]', '2025-07-29 23:16:33', '2025-07-29 23:16:33', '12000 Dr M.L.K. Jr St N, St. Petersburg, FL, USA', 25.00, 'America/New_York', 'active', '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"15:00\",\"enabled\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"12:00\",\"enabled\":false}}', '[]', '[]', 1.00),
(5, 3, 'Bedbug', 'Best ares', '[\"84107\"]', '2025-08-06 16:43:21', '2025-08-06 16:43:21', 'Malstrom Ct, Murray, UT, USA', 25.00, 'America/New_York', 'active', '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"15:00\",\"enabled\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"12:00\",\"enabled\":false}}', '[]', '[]', 1.00);

-- --------------------------------------------------------

--
-- Table structure for table `territory_pricing`
--

CREATE TABLE `territory_pricing` (
  `id` int NOT NULL,
  `territory_id` int NOT NULL,
  `service_id` int NOT NULL,
  `base_price` decimal(10,2) NOT NULL,
  `price_multiplier` decimal(3,2) DEFAULT '1.00',
  `minimum_price` decimal(10,2) DEFAULT NULL,
  `maximum_price` decimal(10,2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `password` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `first_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `last_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `business_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `business_email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `email_notifications` tinyint(1) DEFAULT '1',
  `sms_notifications` tinyint(1) DEFAULT '0',
  `profile_picture` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_active` tinyint(1) DEFAULT '1' COMMENT 'Whether the business is active and visible',
  `business_slug` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `email`, `password`, `first_name`, `last_name`, `business_name`, `business_email`, `phone`, `email_notifications`, `sms_notifications`, `profile_picture`, `created_at`, `updated_at`, `is_active`, `business_slug`) VALUES
(1, 'info@zenbooker.com', 'Just web1#', 'Adeniyi', 'Adejuwon', 'zenbooker-cleaning-services', NULL, '+1 (555) 123-4567', 1, 0, NULL, '2025-07-07 00:23:16', '2025-07-19 21:55:05', 1, 'business-1'),
(2, 'adeniyiadejuwon02@gmail.com', 'Just web1#', 'Adeniyi', 'Adejuwon', 'now2code-academy', NULL, '08107370125', 1, 1, 'http://localhost:5000/uploads/profile-1752286896710-197354963.png', '2025-07-12 01:37:30', '2025-07-19 21:55:05', 1, 'business-2'),
(3, 'adeniyiadejuwon220@gmail.com', '$2a$12$Npzhxu/y/Lu052Z3mNscReOAGE0zIYjfKGmZJjo8ftDdsizQLL8hu', 'Adeniyi', 'Adejuwon', 'now2code academy 1', 'ajajaolamilekan@gmail.com', '+2348107370125', 1, 1, 'https://zenbookapi.now2code.online/uploads/profile-3-1754867022999-3a8c9fe6-2a76-4ace-aa07-415d994de6f0.png', '2025-07-15 01:50:29', '2025-08-10 23:15:15', 1, 'business-3'),
(4, 'test@zenbooker.com', '$2a$12$mJQ/GprnVPTaeoJKl5gip.1JF9Bclku5dIJ0zdZ48JUaYDEetpGZC', 'Test', 'User', 'now2codeacademy1', NULL, NULL, 1, 0, NULL, '2025-07-15 01:58:46', '2025-07-19 21:55:05', 1, 'business-4'),
(5, 'sayapingeorge@gmail.com', '$2a$12$Gyinkam0LoZ5GMalhi2iN.QNy75W56EN2y4Djq4QlFufv75TPTXk6', 'Georgiy', 'Sayapin', 'Spotless Homes', '', '8139212100', 1, 0, 'https://zenbookapi.now2code.online/uploads/profile-5-1754959484690-LogoSquereYellow280kb.png', '2025-07-21 22:30:07', '2025-08-14 14:44:00', 1, NULL),
(6, 'joshua@now2code.com', '$2a$12$PxHs34XINOUSLpiShT.wsuQTiidbADuJwcysRMBO49.WNKIV83Uy2', 'Ajaja', 'Joshua', 'Now2Code', NULL, NULL, 1, 0, NULL, '2025-07-22 18:45:34', '2025-07-22 18:45:34', 1, NULL),
(7, 'joshua22@now2code.com', '$2a$12$lNBBm6Um5Qew09fREuFSXecmX.p593gcXgIO38BH/WLRbW8QSqV1W', 'Joshua', 'Now2code', 'Now2code Agency', NULL, NULL, 1, 0, NULL, '2025-07-26 20:11:42', '2025-07-26 20:11:42', 1, NULL),
(8, 'jj@gmail.com', '$2a$12$J076Z523jtMx.GjSeEXAE.I4/zGn1kUaAfooW1QSrYTik7mALX4xO', 'John', 'James', 'JJ', NULL, NULL, 1, 0, NULL, '2025-07-26 22:00:41', '2025-07-26 22:00:41', 1, NULL),
(9, 'jj3@gmail.com', '$2a$12$UxFHiYi86BBWoUSHNRPmIefKFZfIPES8fd.tDh/3TTzehgWf.DIpW', 'john', 'james', 'jjjj', NULL, NULL, 1, 0, NULL, '2025-07-27 13:11:22', '2025-07-27 13:11:22', 1, NULL),
(10, 'joshua@enow2code.com', '$2a$12$X23.5GsjpQMhHiJVafBt9ejmrQg.FOXtj5QRZhrdSYXBo1vnfOs0m', 'ELIAS', 'GIZAW', 'Now2Code', NULL, NULL, 1, 0, NULL, '2025-08-06 14:28:38', '2025-08-06 14:28:38', 1, NULL),
(11, 'bopmack1@gmail.com', '$2a$12$T/kaRM45EZgpgyiG66lXtejk.mNdf9ST8czknIpQkqtIcFZ0y9Bwy', 'Elias', 'Gizaw', 'Elaiscash', NULL, NULL, 1, 0, NULL, '2025-08-23 17:54:21', '2025-08-23 17:54:21', 1, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `user_availability`
--

CREATE TABLE `user_availability` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `business_hours` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `timeslot_templates` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

--
-- Dumping data for table `user_availability`
--

INSERT INTO `user_availability` (`id`, `user_id`, `business_hours`, `timeslot_templates`, `created_at`, `updated_at`) VALUES
(1, 1, '{\"monday\": {\"start\": \"09:00\", \"end\": \"17:00\"}, \"tuesday\": {\"start\": \"09:00\", \"end\": \"17:00\"}, \"wednesday\": {\"start\": \"09:00\", \"end\": \"17:00\"}, \"thursday\": {\"start\": \"09:00\", \"end\": \"17:00\"}, \"friday\": {\"start\": \"09:00\", \"end\": \"17:00\"}, \"saturday\": {\"start\": \"09:00\", \"end\": \"15:00\"}, \"sunday\": {\"start\": \"09:00\", \"end\": \"12:00\"}}', '{\"slot_duration\": 30, \"buffer_time\": 15}', '2025-07-18 21:06:42', '2025-07-18 21:06:42'),
(2, 3, '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":false}}', '[{\"days\":{\"Sunday\":{\"enabled\":false,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Monday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Tuesday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Wednesday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Thursday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Friday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Saturday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"}},\"timeslotType\":\"Fixed length\"}]', '2025-07-19 02:16:22', '2025-07-19 02:16:22'),
(3, 3, '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"sunday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":false}}', '[{\"days\":{\"Sunday\":{\"enabled\":false,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Monday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Tuesday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Wednesday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Thursday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Friday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"},\"Saturday\":{\"enabled\":true,\"startTime\":\"9:00 AM\",\"endTime\":\"6:00 PM\"}},\"timeslotType\":\"Fixed length\"}]', '2025-07-19 02:16:46', '2025-07-19 02:16:46'),
(4, 5, '{\"monday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"tuesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"wednesday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"thursday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"friday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":true},\"saturday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":false},\"sunday\":{\"start\":\"09:00\",\"end\":\"17:00\",\"enabled\":false}}', '[]', '2025-08-12 00:37:11', '2025-08-12 00:37:11');

-- --------------------------------------------------------

--
-- Table structure for table `user_billing`
--

CREATE TABLE `user_billing` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `subscription_plan` varchar(100) COLLATE utf8mb4_general_ci DEFAULT 'Standard',
  `monthly_price` decimal(10,2) DEFAULT '29.00',
  `card_last4` varchar(4) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `trial_end_date` datetime DEFAULT NULL,
  `is_trial` tinyint(1) DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_branding`
--

CREATE TABLE `user_branding` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `logo_url` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `show_logo_in_admin` tinyint(1) DEFAULT '0',
  `primary_color` varchar(7) COLLATE utf8mb4_general_ci DEFAULT '#4CAF50',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `user_branding`
--

INSERT INTO `user_branding` (`id`, `user_id`, `logo_url`, `show_logo_in_admin`, `primary_color`, `created_at`, `updated_at`) VALUES
(1, 3, 'https://zenbookapi.now2code.online/uploads/logo-3-1754865764917-88f60822ae42b7117b031ddc03a898d2.jpg', 0, '#E91E63', '2025-08-10 22:42:44', '2025-08-11 01:16:27'),
(2, 3, 'https://zenbookapi.now2code.online/uploads/logo-3-1754865764917-88f60822ae42b7117b031ddc03a898d2.jpg', 0, '#E91E63', '2025-08-10 22:53:38', '2025-08-11 01:16:27'),
(3, 5, 'https://zenbookapi.now2code.online/uploads/logo-5-1755182680365-LogoSquereYellow280kb.png', 0, '#E91E63', '2025-08-14 14:44:40', '2025-08-14 14:44:46');

-- --------------------------------------------------------

--
-- Table structure for table `user_notification_settings`
--

CREATE TABLE `user_notification_settings` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `notification_type` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  `email_enabled` tinyint(1) DEFAULT '1',
  `sms_enabled` tinyint(1) DEFAULT '0',
  `push_enabled` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `user_notification_settings`
--

INSERT INTO `user_notification_settings` (`id`, `user_id`, `notification_type`, `email_enabled`, `sms_enabled`, `push_enabled`, `created_at`, `updated_at`) VALUES
(1, 1, 'appointment_confirmation', 1, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(2, 1, 'appointment_reminder', 1, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(3, 1, 'appointment_cancelled', 1, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(4, 1, 'appointment_rescheduled', 1, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(5, 1, 'enroute', 0, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(6, 1, 'job_follow_up', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(7, 1, 'payment_receipt', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(8, 1, 'invoice', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(9, 1, 'estimate', 1, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(10, 1, 'quote_request_processing', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(11, 1, 'booking_request_acknowledgment', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(12, 1, 'recurring_booking_cancelled', 1, 1, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(13, 1, 'contact_customer', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(14, 1, 'team_member_invite', 1, 0, 0, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(15, 1, 'assigned_job_cancelled', 1, 1, 1, '2025-08-10 23:28:51', '2025-08-10 23:28:51'),
(16, 1, 'assigned_job_rescheduled', 1, 1, 1, '2025-08-10 23:28:51', '2025-08-10 23:28:51');

-- --------------------------------------------------------

--
-- Table structure for table `user_payment_settings`
--

CREATE TABLE `user_payment_settings` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `online_booking_tips` tinyint(1) DEFAULT '0',
  `invoice_payment_tips` tinyint(1) DEFAULT '0',
  `show_service_prices` tinyint(1) DEFAULT '1',
  `show_service_descriptions` tinyint(1) DEFAULT '0',
  `payment_due_days` int DEFAULT '15',
  `payment_due_unit` enum('days','weeks','months') COLLATE utf8mb4_general_ci DEFAULT 'days',
  `default_memo` text COLLATE utf8mb4_general_ci,
  `invoice_footer` text COLLATE utf8mb4_general_ci,
  `payment_processor` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `payment_processor_connected` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `user_payment_settings`
--

INSERT INTO `user_payment_settings` (`id`, `user_id`, `online_booking_tips`, `invoice_payment_tips`, `show_service_prices`, `show_service_descriptions`, `payment_due_days`, `payment_due_unit`, `default_memo`, `invoice_footer`, `payment_processor`, `payment_processor_connected`, `created_at`, `updated_at`) VALUES
(1, 3, 1, 1, 1, 0, 15, 'days', '', '', 'stripe', 1, '2025-08-11 01:08:51', '2025-08-14 00:21:30');

-- --------------------------------------------------------

--
-- Table structure for table `user_service_areas`
--

CREATE TABLE `user_service_areas` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `enforce_service_area` tinyint(1) DEFAULT '1',
  `territories` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ;

--
-- Dumping data for table `user_service_areas`
--

INSERT INTO `user_service_areas` (`id`, `user_id`, `enforce_service_area`, `territories`, `created_at`, `updated_at`) VALUES
(1, 3, 1, '[{\"id\":1,\"name\":\"Just web\",\"description\":\"\",\"location\":\"Chelsea Avenue, Memphis, TN, USA\",\"radius_miles\":\"25.00\",\"status\":\"active\"},{\"id\":5,\"name\":\"Bedbug\",\"description\":\"Best ares\",\"location\":\"Malstrom Ct, Murray, UT, USA\",\"radius_miles\":\"25.00\",\"status\":\"active\"}]', '2025-08-14 01:36:24', '2025-08-14 01:36:24');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `booking_settings`
--
ALTER TABLE `booking_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_user_settings` (`user_id`);

--
-- Indexes for table `coupons`
--
ALTER TABLE `coupons`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `code` (`code`),
  ADD KEY `idx_user_code` (`user_id`,`code`),
  ADD KEY `idx_active_coupons` (`is_active`,`expiration_date`);

--
-- Indexes for table `coupon_usage`
--
ALTER TABLE `coupon_usage`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `job_id` (`job_id`),
  ADD KEY `invoice_id` (`invoice_id`),
  ADD KEY `idx_coupon_usage` (`coupon_id`,`customer_id`);

--
-- Indexes for table `customers`
--
ALTER TABLE `customers`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_customers_user_id` (`user_id`),
  ADD KEY `idx_customers_status` (`status`);

--
-- Indexes for table `customer_notifications`
--
ALTER TABLE `customer_notifications`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `job_id` (`job_id`);

--
-- Indexes for table `customer_notification_preferences`
--
ALTER TABLE `customer_notification_preferences`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `customer_id` (`customer_id`);

--
-- Indexes for table `custom_payment_methods`
--
ALTER TABLE `custom_payment_methods`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `estimates`
--
ALTER TABLE `estimates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `idx_estimates_user_id` (`user_id`);

--
-- Indexes for table `invoices`
--
ALTER TABLE `invoices`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `job_id` (`job_id`),
  ADD KEY `estimate_id` (`estimate_id`);

--
-- Indexes for table `jobs`
--
ALTER TABLE `jobs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `customer_id` (`customer_id`),
  ADD KEY `service_id` (`service_id`),
  ADD KEY `idx_jobs_user_id` (`user_id`),
  ADD KEY `idx_jobs_status` (`status`),
  ADD KEY `idx_jobs_scheduled_date` (`scheduled_date`),
  ADD KEY `idx_jobs_invoice_status` (`invoice_status`),
  ADD KEY `idx_jobs_team_member_id` (`team_member_id`),
  ADD KEY `idx_jobs_invoice_id` (`invoice_id`),
  ADD KEY `idx_jobs_territory_id` (`territory_id`),
  ADD KEY `idx_jobs_recurring` (`is_recurring`,`next_billing_date`);

--
-- Indexes for table `job_answers`
--
ALTER TABLE `job_answers`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_job_answers_job_id` (`job_id`),
  ADD KEY `idx_job_answers_question_id` (`question_id`);

--
-- Indexes for table `job_team_assignments`
--
ALTER TABLE `job_team_assignments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_job_team_member` (`job_id`,`team_member_id`),
  ADD KEY `idx_job_id` (`job_id`),
  ADD KEY `idx_team_member_id` (`team_member_id`),
  ADD KEY `idx_is_primary` (`is_primary`),
  ADD KEY `idx_job_team_assignments_lookup` (`job_id`,`is_primary`);

--
-- Indexes for table `job_templates`
--
ALTER TABLE `job_templates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `service_id` (`service_id`),
  ADD KEY `idx_job_templates_user_id` (`user_id`);

--
-- Indexes for table `notification_templates`
--
ALTER TABLE `notification_templates`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_template_type_name` (`user_id`,`template_type`,`notification_name`),
  ADD KEY `idx_notification_templates_user_id` (`user_id`);

--
-- Indexes for table `requests`
--
ALTER TABLE `requests`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_id` (`user_id`),
  ADD KEY `idx_customer_id` (`customer_id`),
  ADD KEY `idx_service_id` (`service_id`),
  ADD KEY `idx_type` (`type`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_scheduled_date` (`scheduled_date`),
  ADD KEY `idx_created_at` (`created_at`);

--
-- Indexes for table `services`
--
ALTER TABLE `services`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_services_user_id` (`user_id`),
  ADD KEY `idx_services_is_active` (`is_active`),
  ADD KEY `idx_services_image` (`image`);

--
-- Indexes for table `service_availability`
--
ALTER TABLE `service_availability`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_service_availability_service_id` (`service_id`),
  ADD KEY `idx_service_availability_user_id` (`user_id`);

--
-- Indexes for table `service_categories`
--
ALTER TABLE `service_categories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_category_name` (`user_id`,`name`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `service_scheduling_rules`
--
ALTER TABLE `service_scheduling_rules`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_service_scheduling_rules_service_id` (`service_id`);

--
-- Indexes for table `service_timeslot_templates`
--
ALTER TABLE `service_timeslot_templates`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_service_timeslot_templates_service_id` (`service_id`);

--
-- Indexes for table `team_members`
--
ALTER TABLE `team_members`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD KEY `fk_user_id` (`user_id`),
  ADD KEY `idx_team_members_email` (`email`),
  ADD KEY `idx_team_members_invitation_token` (`invitation_token`),
  ADD KEY `idx_team_members_status` (`status`);

--
-- Indexes for table `territories`
--
ALTER TABLE `territories`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `territory_pricing`
--
ALTER TABLE `territory_pricing`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_territory_service` (`territory_id`,`service_id`),
  ADD KEY `service_id` (`service_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD UNIQUE KEY `business_slug` (`business_slug`),
  ADD KEY `idx_users_email` (`email`),
  ADD KEY `idx_users_business_name` (`business_name`),
  ADD KEY `idx_users_business_slug` (`business_slug`),
  ADD KEY `idx_users_business_email` (`business_email`);

--
-- Indexes for table `user_availability`
--
ALTER TABLE `user_availability`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_availability_user_id` (`user_id`);

--
-- Indexes for table `user_billing`
--
ALTER TABLE `user_billing`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`);

--
-- Indexes for table `user_branding`
--
ALTER TABLE `user_branding`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_branding_user_id` (`user_id`);

--
-- Indexes for table `user_notification_settings`
--
ALTER TABLE `user_notification_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_notification_type` (`user_id`,`notification_type`),
  ADD KEY `idx_user_notification_settings_user_id` (`user_id`);

--
-- Indexes for table `user_payment_settings`
--
ALTER TABLE `user_payment_settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `unique_user_payment_settings` (`user_id`);

--
-- Indexes for table `user_service_areas`
--
ALTER TABLE `user_service_areas`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_service_areas_user_id` (`user_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `booking_settings`
--
ALTER TABLE `booking_settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `coupons`
--
ALTER TABLE `coupons`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `coupon_usage`
--
ALTER TABLE `coupon_usage`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `customers`
--
ALTER TABLE `customers`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=79;

--
-- AUTO_INCREMENT for table `customer_notifications`
--
ALTER TABLE `customer_notifications`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `customer_notification_preferences`
--
ALTER TABLE `customer_notification_preferences`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;

--
-- AUTO_INCREMENT for table `custom_payment_methods`
--
ALTER TABLE `custom_payment_methods`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT for table `estimates`
--
ALTER TABLE `estimates`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `invoices`
--
ALTER TABLE `invoices`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=10;

--
-- AUTO_INCREMENT for table `jobs`
--
ALTER TABLE `jobs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `job_answers`
--
ALTER TABLE `job_answers`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=74;

--
-- AUTO_INCREMENT for table `job_team_assignments`
--
ALTER TABLE `job_team_assignments`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=97;

--
-- AUTO_INCREMENT for table `job_templates`
--
ALTER TABLE `job_templates`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `notification_templates`
--
ALTER TABLE `notification_templates`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=42303;

--
-- AUTO_INCREMENT for table `requests`
--
ALTER TABLE `requests`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=19;

--
-- AUTO_INCREMENT for table `services`
--
ALTER TABLE `services`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `service_availability`
--
ALTER TABLE `service_availability`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `service_categories`
--
ALTER TABLE `service_categories`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=30;

--
-- AUTO_INCREMENT for table `service_scheduling_rules`
--
ALTER TABLE `service_scheduling_rules`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `service_timeslot_templates`
--
ALTER TABLE `service_timeslot_templates`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `team_members`
--
ALTER TABLE `team_members`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `territories`
--
ALTER TABLE `territories`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `territory_pricing`
--
ALTER TABLE `territory_pricing`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

--
-- AUTO_INCREMENT for table `user_availability`
--
ALTER TABLE `user_availability`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_billing`
--
ALTER TABLE `user_billing`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_branding`
--
ALTER TABLE `user_branding`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `user_notification_settings`
--
ALTER TABLE `user_notification_settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=29098;

--
-- AUTO_INCREMENT for table `user_payment_settings`
--
ALTER TABLE `user_payment_settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `user_service_areas`
--
ALTER TABLE `user_service_areas`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `booking_settings`
--
ALTER TABLE `booking_settings`
  ADD CONSTRAINT `booking_settings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `coupons`
--
ALTER TABLE `coupons`
  ADD CONSTRAINT `coupons_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `coupon_usage`
--
ALTER TABLE `coupon_usage`
  ADD CONSTRAINT `coupon_usage_ibfk_1` FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `coupon_usage_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `coupon_usage_ibfk_3` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `coupon_usage_ibfk_4` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `customers`
--
ALTER TABLE `customers`
  ADD CONSTRAINT `customers_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `customer_notifications`
--
ALTER TABLE `customer_notifications`
  ADD CONSTRAINT `customer_notifications_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `customer_notifications_ibfk_2` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `customer_notification_preferences`
--
ALTER TABLE `customer_notification_preferences`
  ADD CONSTRAINT `customer_notification_preferences_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `custom_payment_methods`
--
ALTER TABLE `custom_payment_methods`
  ADD CONSTRAINT `custom_payment_methods_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `estimates`
--
ALTER TABLE `estimates`
  ADD CONSTRAINT `estimates_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `estimates_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `invoices`
--
ALTER TABLE `invoices`
  ADD CONSTRAINT `invoices_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `invoices_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `invoices_ibfk_3` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `invoices_ibfk_4` FOREIGN KEY (`estimate_id`) REFERENCES `estimates` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `jobs`
--
ALTER TABLE `jobs`
  ADD CONSTRAINT `fk_jobs_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_jobs_territory` FOREIGN KEY (`territory_id`) REFERENCES `territories` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `jobs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `jobs_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `jobs_ibfk_3` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `jobs_ibfk_4` FOREIGN KEY (`team_member_id`) REFERENCES `team_members` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `job_answers`
--
ALTER TABLE `job_answers`
  ADD CONSTRAINT `job_answers_ibfk_1` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `job_team_assignments`
--
ALTER TABLE `job_team_assignments`
  ADD CONSTRAINT `job_team_assignments_ibfk_1` FOREIGN KEY (`job_id`) REFERENCES `jobs` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `job_team_assignments_ibfk_2` FOREIGN KEY (`team_member_id`) REFERENCES `team_members` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `job_templates`
--
ALTER TABLE `job_templates`
  ADD CONSTRAINT `job_templates_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `notification_templates`
--
ALTER TABLE `notification_templates`
  ADD CONSTRAINT `notification_templates_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `requests`
--
ALTER TABLE `requests`
  ADD CONSTRAINT `requests_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `requests_ibfk_2` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `requests_ibfk_3` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `services`
--
ALTER TABLE `services`
  ADD CONSTRAINT `services_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `service_availability`
--
ALTER TABLE `service_availability`
  ADD CONSTRAINT `service_availability_ibfk_1` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `service_availability_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `service_categories`
--
ALTER TABLE `service_categories`
  ADD CONSTRAINT `fk_categories_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `service_scheduling_rules`
--
ALTER TABLE `service_scheduling_rules`
  ADD CONSTRAINT `service_scheduling_rules_ibfk_1` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `service_timeslot_templates`
--
ALTER TABLE `service_timeslot_templates`
  ADD CONSTRAINT `service_timeslot_templates_ibfk_1` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `team_members`
--
ALTER TABLE `team_members`
  ADD CONSTRAINT `fk_team_members_user_id` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `territories`
--
ALTER TABLE `territories`
  ADD CONSTRAINT `territories_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `territory_pricing`
--
ALTER TABLE `territory_pricing`
  ADD CONSTRAINT `territory_pricing_ibfk_1` FOREIGN KEY (`territory_id`) REFERENCES `territories` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `territory_pricing_ibfk_2` FOREIGN KEY (`service_id`) REFERENCES `services` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_availability`
--
ALTER TABLE `user_availability`
  ADD CONSTRAINT `user_availability_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_billing`
--
ALTER TABLE `user_billing`
  ADD CONSTRAINT `user_billing_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_branding`
--
ALTER TABLE `user_branding`
  ADD CONSTRAINT `user_branding_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_notification_settings`
--
ALTER TABLE `user_notification_settings`
  ADD CONSTRAINT `user_notification_settings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_payment_settings`
--
ALTER TABLE `user_payment_settings`
  ADD CONSTRAINT `user_payment_settings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `user_service_areas`
--
ALTER TABLE `user_service_areas`
  ADD CONSTRAINT `user_service_areas_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
