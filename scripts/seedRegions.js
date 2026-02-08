const mongoose = require('mongoose');
require('dotenv').config();

// Import the actual Region model
const Region = require('../models/Region');

// Helper to create slug from name
const createSlug = (name, state) => {
  return `${name}-${state}`.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
};

// All Indian Cities - State wise
const indianCities = [
  // Andhra Pradesh
  { name: 'Visakhapatnam', state: 'Andhra Pradesh', coordinates: { latitude: 17.6868, longitude: 83.2185 } },
  { name: 'Vijayawada', state: 'Andhra Pradesh', coordinates: { latitude: 16.5062, longitude: 80.6480 } },
  { name: 'Guntur', state: 'Andhra Pradesh', coordinates: { latitude: 16.3067, longitude: 80.4365 } },
  { name: 'Nellore', state: 'Andhra Pradesh', coordinates: { latitude: 14.4426, longitude: 79.9865 } },
  { name: 'Tirupati', state: 'Andhra Pradesh', coordinates: { latitude: 13.6288, longitude: 79.4192 } },
  { name: 'Rajahmundry', state: 'Andhra Pradesh', coordinates: { latitude: 17.0005, longitude: 81.8040 } },
  { name: 'Kakinada', state: 'Andhra Pradesh', coordinates: { latitude: 16.9891, longitude: 82.2475 } },
  { name: 'Kurnool', state: 'Andhra Pradesh', coordinates: { latitude: 15.8281, longitude: 78.0373 } },
  { name: 'Anantapur', state: 'Andhra Pradesh', coordinates: { latitude: 14.6819, longitude: 77.6006 } },
  { name: 'Kadapa', state: 'Andhra Pradesh', coordinates: { latitude: 14.4674, longitude: 78.8241 } },

  // Arunachal Pradesh
  { name: 'Itanagar', state: 'Arunachal Pradesh', coordinates: { latitude: 27.0844, longitude: 93.6053 } },
  { name: 'Naharlagun', state: 'Arunachal Pradesh', coordinates: { latitude: 27.1045, longitude: 93.6947 } },

  // Assam
  { name: 'Guwahati', state: 'Assam', coordinates: { latitude: 26.1445, longitude: 91.7362 } },
  { name: 'Silchar', state: 'Assam', coordinates: { latitude: 24.8333, longitude: 92.7789 } },
  { name: 'Dibrugarh', state: 'Assam', coordinates: { latitude: 27.4728, longitude: 94.9120 } },
  { name: 'Jorhat', state: 'Assam', coordinates: { latitude: 26.7509, longitude: 94.2037 } },
  { name: 'Nagaon', state: 'Assam', coordinates: { latitude: 26.3500, longitude: 92.6833 } },
  { name: 'Tinsukia', state: 'Assam', coordinates: { latitude: 27.4922, longitude: 95.3470 } },
  { name: 'Tezpur', state: 'Assam', coordinates: { latitude: 26.6528, longitude: 92.7926 } },

  // Bihar
  { name: 'Patna', state: 'Bihar', coordinates: { latitude: 25.5941, longitude: 85.1376 } },
  { name: 'Gaya', state: 'Bihar', coordinates: { latitude: 24.7914, longitude: 85.0002 } },
  { name: 'Bhagalpur', state: 'Bihar', coordinates: { latitude: 25.2425, longitude: 86.9842 } },
  { name: 'Muzaffarpur', state: 'Bihar', coordinates: { latitude: 26.1225, longitude: 85.3906 } },
  { name: 'Purnia', state: 'Bihar', coordinates: { latitude: 25.7771, longitude: 87.4753 } },
  { name: 'Darbhanga', state: 'Bihar', coordinates: { latitude: 26.1542, longitude: 85.8918 } },
  { name: 'Bihar Sharif', state: 'Bihar', coordinates: { latitude: 25.1982, longitude: 85.5204 } },
  { name: 'Arrah', state: 'Bihar', coordinates: { latitude: 25.5541, longitude: 84.6606 } },
  { name: 'Begusarai', state: 'Bihar', coordinates: { latitude: 25.4182, longitude: 86.1272 } },
  { name: 'Katihar', state: 'Bihar', coordinates: { latitude: 25.5392, longitude: 87.5719 } },

  // Chhattisgarh
  { name: 'Raipur', state: 'Chhattisgarh', coordinates: { latitude: 21.2514, longitude: 81.6296 } },
  { name: 'Bhilai', state: 'Chhattisgarh', coordinates: { latitude: 21.2167, longitude: 81.3500 } },
  { name: 'Bilaspur', state: 'Chhattisgarh', coordinates: { latitude: 22.0796, longitude: 82.1391 } },
  { name: 'Korba', state: 'Chhattisgarh', coordinates: { latitude: 22.3595, longitude: 82.7501 } },
  { name: 'Durg', state: 'Chhattisgarh', coordinates: { latitude: 21.1904, longitude: 81.2849 } },
  { name: 'Rajnandgaon', state: 'Chhattisgarh', coordinates: { latitude: 21.0974, longitude: 81.0280 } },
  { name: 'Jagdalpur', state: 'Chhattisgarh', coordinates: { latitude: 19.0785, longitude: 82.0217 } },
  { name: 'Raigarh', state: 'Chhattisgarh', coordinates: { latitude: 21.8974, longitude: 83.3950 } },

  // Delhi NCR
  { name: 'New Delhi', state: 'Delhi', coordinates: { latitude: 28.6139, longitude: 77.2090 } },
  { name: 'Delhi', state: 'Delhi', coordinates: { latitude: 28.7041, longitude: 77.1025 } },
  { name: 'Noida', state: 'Uttar Pradesh', coordinates: { latitude: 28.5355, longitude: 77.3910 } },
  { name: 'Gurgaon', state: 'Haryana', coordinates: { latitude: 28.4595, longitude: 77.0266 } },
  { name: 'Faridabad', state: 'Haryana', coordinates: { latitude: 28.4089, longitude: 77.3178 } },
  { name: 'Ghaziabad', state: 'Uttar Pradesh', coordinates: { latitude: 28.6692, longitude: 77.4538 } },
  { name: 'Greater Noida', state: 'Uttar Pradesh', coordinates: { latitude: 28.4744, longitude: 77.5040 } },

  // Goa
  { name: 'Panaji', state: 'Goa', coordinates: { latitude: 15.4909, longitude: 73.8278 } },
  { name: 'Margao', state: 'Goa', coordinates: { latitude: 15.2832, longitude: 73.9862 } },
  { name: 'Vasco da Gama', state: 'Goa', coordinates: { latitude: 15.3982, longitude: 73.8113 } },
  { name: 'Mapusa', state: 'Goa', coordinates: { latitude: 15.5937, longitude: 73.8064 } },
  { name: 'Ponda', state: 'Goa', coordinates: { latitude: 15.4030, longitude: 74.0152 } },

  // Gujarat
  { name: 'Ahmedabad', state: 'Gujarat', coordinates: { latitude: 23.0225, longitude: 72.5714 } },
  { name: 'Surat', state: 'Gujarat', coordinates: { latitude: 21.1702, longitude: 72.8311 } },
  { name: 'Vadodara', state: 'Gujarat', coordinates: { latitude: 22.3072, longitude: 73.1812 } },
  { name: 'Rajkot', state: 'Gujarat', coordinates: { latitude: 22.3039, longitude: 70.8022 } },
  { name: 'Bhavnagar', state: 'Gujarat', coordinates: { latitude: 21.7645, longitude: 72.1519 } },
  { name: 'Jamnagar', state: 'Gujarat', coordinates: { latitude: 22.4707, longitude: 70.0577 } },
  { name: 'Junagadh', state: 'Gujarat', coordinates: { latitude: 21.5222, longitude: 70.4579 } },
  { name: 'Gandhinagar', state: 'Gujarat', coordinates: { latitude: 23.2156, longitude: 72.6369 } },
  { name: 'Anand', state: 'Gujarat', coordinates: { latitude: 22.5645, longitude: 72.9289 } },
  { name: 'Nadiad', state: 'Gujarat', coordinates: { latitude: 22.6916, longitude: 72.8634 } },
  { name: 'Morbi', state: 'Gujarat', coordinates: { latitude: 22.8200, longitude: 70.8300 } },
  { name: 'Mehsana', state: 'Gujarat', coordinates: { latitude: 23.5880, longitude: 72.3693 } },
  { name: 'Bharuch', state: 'Gujarat', coordinates: { latitude: 21.6942, longitude: 72.9893 } },
  { name: 'Porbandar', state: 'Gujarat', coordinates: { latitude: 21.6417, longitude: 69.6293 } },
  { name: 'Navsari', state: 'Gujarat', coordinates: { latitude: 20.9467, longitude: 72.9520 } },

  // Haryana
  { name: 'Chandigarh', state: 'Chandigarh', coordinates: { latitude: 30.7333, longitude: 76.7794 } },
  { name: 'Ambala', state: 'Haryana', coordinates: { latitude: 30.3782, longitude: 76.7767 } },
  { name: 'Panipat', state: 'Haryana', coordinates: { latitude: 29.3909, longitude: 76.9635 } },
  { name: 'Karnal', state: 'Haryana', coordinates: { latitude: 29.6857, longitude: 76.9905 } },
  { name: 'Rohtak', state: 'Haryana', coordinates: { latitude: 28.8955, longitude: 76.6066 } },
  { name: 'Hisar', state: 'Haryana', coordinates: { latitude: 29.1492, longitude: 75.7217 } },
  { name: 'Sonipat', state: 'Haryana', coordinates: { latitude: 28.9288, longitude: 77.0913 } },
  { name: 'Yamunanagar', state: 'Haryana', coordinates: { latitude: 30.1290, longitude: 77.2674 } },
  { name: 'Panchkula', state: 'Haryana', coordinates: { latitude: 30.6942, longitude: 76.8606 } },
  { name: 'Bhiwani', state: 'Haryana', coordinates: { latitude: 28.7930, longitude: 76.1322 } },
  { name: 'Sirsa', state: 'Haryana', coordinates: { latitude: 29.5349, longitude: 75.0287 } },
  { name: 'Jind', state: 'Haryana', coordinates: { latitude: 29.3164, longitude: 76.3152 } },

  // Himachal Pradesh
  { name: 'Shimla', state: 'Himachal Pradesh', coordinates: { latitude: 31.1048, longitude: 77.1734 } },
  { name: 'Dharamshala', state: 'Himachal Pradesh', coordinates: { latitude: 32.2190, longitude: 76.3234 } },
  { name: 'Solan', state: 'Himachal Pradesh', coordinates: { latitude: 30.9045, longitude: 77.0967 } },
  { name: 'Mandi', state: 'Himachal Pradesh', coordinates: { latitude: 31.7082, longitude: 76.9314 } },
  { name: 'Kullu', state: 'Himachal Pradesh', coordinates: { latitude: 31.9592, longitude: 77.1089 } },
  { name: 'Manali', state: 'Himachal Pradesh', coordinates: { latitude: 32.2396, longitude: 77.1887 } },
  { name: 'Baddi', state: 'Himachal Pradesh', coordinates: { latitude: 30.9578, longitude: 76.7914 } },

  // Jharkhand
  { name: 'Ranchi', state: 'Jharkhand', coordinates: { latitude: 23.3441, longitude: 85.3096 } },
  { name: 'Jamshedpur', state: 'Jharkhand', coordinates: { latitude: 22.8046, longitude: 86.2029 } },
  { name: 'Dhanbad', state: 'Jharkhand', coordinates: { latitude: 23.7957, longitude: 86.4304 } },
  { name: 'Bokaro', state: 'Jharkhand', coordinates: { latitude: 23.6693, longitude: 86.1511 } },
  { name: 'Hazaribagh', state: 'Jharkhand', coordinates: { latitude: 23.9925, longitude: 85.3637 } },
  { name: 'Deoghar', state: 'Jharkhand', coordinates: { latitude: 24.4764, longitude: 86.6946 } },
  { name: 'Giridih', state: 'Jharkhand', coordinates: { latitude: 24.1903, longitude: 86.3003 } },
  { name: 'Ramgarh', state: 'Jharkhand', coordinates: { latitude: 23.6387, longitude: 85.5616 } },

  // Karnataka
  { name: 'Bengaluru', state: 'Karnataka', coordinates: { latitude: 12.9716, longitude: 77.5946 } },
  { name: 'Mysuru', state: 'Karnataka', coordinates: { latitude: 12.2958, longitude: 76.6394 } },
  { name: 'Mangaluru', state: 'Karnataka', coordinates: { latitude: 12.9141, longitude: 74.8560 } },
  { name: 'Hubli', state: 'Karnataka', coordinates: { latitude: 15.3647, longitude: 75.1240 } },
  { name: 'Dharwad', state: 'Karnataka', coordinates: { latitude: 15.4589, longitude: 75.0078 } },
  { name: 'Belgaum', state: 'Karnataka', coordinates: { latitude: 15.8497, longitude: 74.4977 } },
  { name: 'Gulbarga', state: 'Karnataka', coordinates: { latitude: 17.3297, longitude: 76.8343 } },
  { name: 'Bellary', state: 'Karnataka', coordinates: { latitude: 15.1394, longitude: 76.9214 } },
  { name: 'Davangere', state: 'Karnataka', coordinates: { latitude: 14.4644, longitude: 75.9218 } },
  { name: 'Shimoga', state: 'Karnataka', coordinates: { latitude: 13.9299, longitude: 75.5681 } },
  { name: 'Tumkur', state: 'Karnataka', coordinates: { latitude: 13.3379, longitude: 77.1173 } },
  { name: 'Udupi', state: 'Karnataka', coordinates: { latitude: 13.3389, longitude: 74.7451 } },
  { name: 'Bijapur', state: 'Karnataka', coordinates: { latitude: 16.8302, longitude: 75.7100 } },
  { name: 'Raichur', state: 'Karnataka', coordinates: { latitude: 16.2160, longitude: 77.3566 } },
  { name: 'Hassan', state: 'Karnataka', coordinates: { latitude: 13.0068, longitude: 76.1004 } },

  // Kerala
  { name: 'Thiruvananthapuram', state: 'Kerala', coordinates: { latitude: 8.5241, longitude: 76.9366 } },
  { name: 'Kochi', state: 'Kerala', coordinates: { latitude: 9.9312, longitude: 76.2673 } },
  { name: 'Kozhikode', state: 'Kerala', coordinates: { latitude: 11.2588, longitude: 75.7804 } },
  { name: 'Thrissur', state: 'Kerala', coordinates: { latitude: 10.5276, longitude: 76.2144 } },
  { name: 'Kollam', state: 'Kerala', coordinates: { latitude: 8.8932, longitude: 76.6141 } },
  { name: 'Kannur', state: 'Kerala', coordinates: { latitude: 11.8745, longitude: 75.3704 } },
  { name: 'Alappuzha', state: 'Kerala', coordinates: { latitude: 9.4981, longitude: 76.3388 } },
  { name: 'Palakkad', state: 'Kerala', coordinates: { latitude: 10.7867, longitude: 76.6548 } },
  { name: 'Kottayam', state: 'Kerala', coordinates: { latitude: 9.5916, longitude: 76.5222 } },
  { name: 'Malappuram', state: 'Kerala', coordinates: { latitude: 11.0510, longitude: 76.0711 } },
  { name: 'Kasaragod', state: 'Kerala', coordinates: { latitude: 12.4996, longitude: 74.9869 } },
  { name: 'Pathanamthitta', state: 'Kerala', coordinates: { latitude: 9.2648, longitude: 76.7870 } },
  { name: 'Idukki', state: 'Kerala', coordinates: { latitude: 9.8503, longitude: 76.9711 } },
  { name: 'Wayanad', state: 'Kerala', coordinates: { latitude: 11.6854, longitude: 76.1320 } },

  // Madhya Pradesh
  { name: 'Bhopal', state: 'Madhya Pradesh', coordinates: { latitude: 23.2599, longitude: 77.4126 } },
  { name: 'Indore', state: 'Madhya Pradesh', coordinates: { latitude: 22.7196, longitude: 75.8577 } },
  { name: 'Jabalpur', state: 'Madhya Pradesh', coordinates: { latitude: 23.1815, longitude: 79.9864 } },
  { name: 'Gwalior', state: 'Madhya Pradesh', coordinates: { latitude: 26.2183, longitude: 78.1828 } },
  { name: 'Ujjain', state: 'Madhya Pradesh', coordinates: { latitude: 23.1765, longitude: 75.7885 } },
  { name: 'Sagar', state: 'Madhya Pradesh', coordinates: { latitude: 23.8388, longitude: 78.7378 } },
  { name: 'Dewas', state: 'Madhya Pradesh', coordinates: { latitude: 22.9676, longitude: 76.0534 } },
  { name: 'Satna', state: 'Madhya Pradesh', coordinates: { latitude: 24.6005, longitude: 80.8322 } },
  { name: 'Ratlam', state: 'Madhya Pradesh', coordinates: { latitude: 23.3315, longitude: 75.0367 } },
  { name: 'Rewa', state: 'Madhya Pradesh', coordinates: { latitude: 24.5362, longitude: 81.3037 } },
  { name: 'Murwara', state: 'Madhya Pradesh', coordinates: { latitude: 23.8500, longitude: 80.4000 } },
  { name: 'Singrauli', state: 'Madhya Pradesh', coordinates: { latitude: 24.1993, longitude: 82.6750 } },
  { name: 'Chhindwara', state: 'Madhya Pradesh', coordinates: { latitude: 22.0574, longitude: 78.9382 } },

  // Maharashtra
  { name: 'Mumbai', state: 'Maharashtra', coordinates: { latitude: 19.0760, longitude: 72.8777 } },
  { name: 'Pune', state: 'Maharashtra', coordinates: { latitude: 18.5204, longitude: 73.8567 } },
  { name: 'Nagpur', state: 'Maharashtra', coordinates: { latitude: 21.1458, longitude: 79.0882 } },
  { name: 'Thane', state: 'Maharashtra', coordinates: { latitude: 19.2183, longitude: 72.9781 } },
  { name: 'Nashik', state: 'Maharashtra', coordinates: { latitude: 19.9975, longitude: 73.7898 } },
  { name: 'Aurangabad', state: 'Maharashtra', coordinates: { latitude: 19.8762, longitude: 75.3433 } },
  { name: 'Solapur', state: 'Maharashtra', coordinates: { latitude: 17.6599, longitude: 75.9064 } },
  { name: 'Kolhapur', state: 'Maharashtra', coordinates: { latitude: 16.7050, longitude: 74.2433 } },
  { name: 'Amravati', state: 'Maharashtra', coordinates: { latitude: 20.9374, longitude: 77.7796 } },
  { name: 'Navi Mumbai', state: 'Maharashtra', coordinates: { latitude: 19.0330, longitude: 73.0297 } },
  { name: 'Sangli', state: 'Maharashtra', coordinates: { latitude: 16.8524, longitude: 74.5815 } },
  { name: 'Malegaon', state: 'Maharashtra', coordinates: { latitude: 20.5579, longitude: 74.5089 } },
  { name: 'Jalgaon', state: 'Maharashtra', coordinates: { latitude: 21.0077, longitude: 75.5626 } },
  { name: 'Akola', state: 'Maharashtra', coordinates: { latitude: 20.7002, longitude: 77.0082 } },
  { name: 'Latur', state: 'Maharashtra', coordinates: { latitude: 18.4088, longitude: 76.5604 } },
  { name: 'Dhule', state: 'Maharashtra', coordinates: { latitude: 20.9042, longitude: 74.7749 } },
  { name: 'Ahmednagar', state: 'Maharashtra', coordinates: { latitude: 19.0948, longitude: 74.7480 } },
  { name: 'Chandrapur', state: 'Maharashtra', coordinates: { latitude: 19.9615, longitude: 79.2961 } },
  { name: 'Parbhani', state: 'Maharashtra', coordinates: { latitude: 19.2704, longitude: 76.7747 } },
  { name: 'Ichalkaranji', state: 'Maharashtra', coordinates: { latitude: 16.6986, longitude: 74.4592 } },
  { name: 'Jalna', state: 'Maharashtra', coordinates: { latitude: 19.8347, longitude: 75.8816 } },
  { name: 'Ambarnath', state: 'Maharashtra', coordinates: { latitude: 19.1857, longitude: 73.1884 } },
  { name: 'Bhiwandi', state: 'Maharashtra', coordinates: { latitude: 19.2813, longitude: 73.0483 } },
  { name: 'Panvel', state: 'Maharashtra', coordinates: { latitude: 18.9894, longitude: 73.1175 } },
  { name: 'Badlapur', state: 'Maharashtra', coordinates: { latitude: 19.1641, longitude: 73.2533 } },
  { name: 'Beed', state: 'Maharashtra', coordinates: { latitude: 18.9890, longitude: 75.7531 } },
  { name: 'Gondia', state: 'Maharashtra', coordinates: { latitude: 21.4624, longitude: 80.1920 } },
  { name: 'Satara', state: 'Maharashtra', coordinates: { latitude: 17.6805, longitude: 74.0183 } },
  { name: 'Barshi', state: 'Maharashtra', coordinates: { latitude: 18.2336, longitude: 75.6912 } },
  { name: 'Yavatmal', state: 'Maharashtra', coordinates: { latitude: 20.3899, longitude: 78.1307 } },
  { name: 'Nanded', state: 'Maharashtra', coordinates: { latitude: 19.1383, longitude: 77.3210 } },
  { name: 'Wardha', state: 'Maharashtra', coordinates: { latitude: 20.7453, longitude: 78.5980 } },
  { name: 'Osmanabad', state: 'Maharashtra', coordinates: { latitude: 18.1861, longitude: 76.0421 } },
  { name: 'Hingoli', state: 'Maharashtra', coordinates: { latitude: 19.7173, longitude: 77.1518 } },
  { name: 'Washim', state: 'Maharashtra', coordinates: { latitude: 20.1072, longitude: 77.1315 } },
  { name: 'Buldhana', state: 'Maharashtra', coordinates: { latitude: 20.5293, longitude: 76.1845 } },

  // Manipur
  { name: 'Imphal', state: 'Manipur', coordinates: { latitude: 24.8170, longitude: 93.9368 } },
  { name: 'Thoubal', state: 'Manipur', coordinates: { latitude: 24.6369, longitude: 94.0120 } },

  // Meghalaya
  { name: 'Shillong', state: 'Meghalaya', coordinates: { latitude: 25.5788, longitude: 91.8933 } },
  { name: 'Tura', state: 'Meghalaya', coordinates: { latitude: 25.5144, longitude: 90.2101 } },

  // Mizoram
  { name: 'Aizawl', state: 'Mizoram', coordinates: { latitude: 23.7271, longitude: 92.7176 } },
  { name: 'Lunglei', state: 'Mizoram', coordinates: { latitude: 22.8879, longitude: 92.7254 } },

  // Nagaland
  { name: 'Kohima', state: 'Nagaland', coordinates: { latitude: 25.6751, longitude: 94.1086 } },
  { name: 'Dimapur', state: 'Nagaland', coordinates: { latitude: 25.9042, longitude: 93.7266 } },

  // Odisha
  { name: 'Bhubaneswar', state: 'Odisha', coordinates: { latitude: 20.2961, longitude: 85.8245 } },
  { name: 'Cuttack', state: 'Odisha', coordinates: { latitude: 20.4625, longitude: 85.8830 } },
  { name: 'Rourkela', state: 'Odisha', coordinates: { latitude: 22.2270, longitude: 84.8524 } },
  { name: 'Berhampur', state: 'Odisha', coordinates: { latitude: 19.3149, longitude: 84.7941 } },
  { name: 'Sambalpur', state: 'Odisha', coordinates: { latitude: 21.4669, longitude: 83.9756 } },
  { name: 'Puri', state: 'Odisha', coordinates: { latitude: 19.8135, longitude: 85.8312 } },
  { name: 'Balasore', state: 'Odisha', coordinates: { latitude: 21.4934, longitude: 86.9135 } },
  { name: 'Bhadrak', state: 'Odisha', coordinates: { latitude: 21.0545, longitude: 86.4958 } },
  { name: 'Baripada', state: 'Odisha', coordinates: { latitude: 21.9322, longitude: 86.7248 } },
  { name: 'Jharsuguda', state: 'Odisha', coordinates: { latitude: 21.8554, longitude: 84.0062 } },

  // Punjab
  { name: 'Ludhiana', state: 'Punjab', coordinates: { latitude: 30.9010, longitude: 75.8573 } },
  { name: 'Amritsar', state: 'Punjab', coordinates: { latitude: 31.6340, longitude: 74.8723 } },
  { name: 'Jalandhar', state: 'Punjab', coordinates: { latitude: 31.3260, longitude: 75.5762 } },
  { name: 'Patiala', state: 'Punjab', coordinates: { latitude: 30.3398, longitude: 76.3869 } },
  { name: 'Bathinda', state: 'Punjab', coordinates: { latitude: 30.2110, longitude: 74.9455 } },
  { name: 'Mohali', state: 'Punjab', coordinates: { latitude: 30.7046, longitude: 76.7179 } },
  { name: 'Pathankot', state: 'Punjab', coordinates: { latitude: 32.2643, longitude: 75.6421 } },
  { name: 'Hoshiarpur', state: 'Punjab', coordinates: { latitude: 31.5143, longitude: 75.9115 } },
  { name: 'Moga', state: 'Punjab', coordinates: { latitude: 30.8160, longitude: 75.1719 } },
  { name: 'Barnala', state: 'Punjab', coordinates: { latitude: 30.3776, longitude: 75.5486 } },
  { name: 'Phagwara', state: 'Punjab', coordinates: { latitude: 31.2240, longitude: 75.7708 } },
  { name: 'Kapurthala', state: 'Punjab', coordinates: { latitude: 31.3808, longitude: 75.3800 } },
  { name: 'Firozpur', state: 'Punjab', coordinates: { latitude: 30.9331, longitude: 74.6225 } },
  { name: 'Khanna', state: 'Punjab', coordinates: { latitude: 30.6912, longitude: 76.2163 } },
  { name: 'Malerkotla', state: 'Punjab', coordinates: { latitude: 30.5302, longitude: 75.8827 } },

  // Rajasthan
  { name: 'Jaipur', state: 'Rajasthan', coordinates: { latitude: 26.9124, longitude: 75.7873 } },
  { name: 'Jodhpur', state: 'Rajasthan', coordinates: { latitude: 26.2389, longitude: 73.0243 } },
  { name: 'Kota', state: 'Rajasthan', coordinates: { latitude: 25.2138, longitude: 75.8648 } },
  { name: 'Bikaner', state: 'Rajasthan', coordinates: { latitude: 28.0229, longitude: 73.3119 } },
  { name: 'Ajmer', state: 'Rajasthan', coordinates: { latitude: 26.4499, longitude: 74.6399 } },
  { name: 'Udaipur', state: 'Rajasthan', coordinates: { latitude: 24.5854, longitude: 73.7125 } },
  { name: 'Bhilwara', state: 'Rajasthan', coordinates: { latitude: 25.3407, longitude: 74.6313 } },
  { name: 'Alwar', state: 'Rajasthan', coordinates: { latitude: 27.5530, longitude: 76.6346 } },
  { name: 'Bharatpur', state: 'Rajasthan', coordinates: { latitude: 27.2152, longitude: 77.4890 } },
  { name: 'Sikar', state: 'Rajasthan', coordinates: { latitude: 27.6094, longitude: 75.1398 } },
  { name: 'Pali', state: 'Rajasthan', coordinates: { latitude: 25.7711, longitude: 73.3234 } },
  { name: 'Sri Ganganagar', state: 'Rajasthan', coordinates: { latitude: 29.9038, longitude: 73.8772 } },
  { name: 'Tonk', state: 'Rajasthan', coordinates: { latitude: 26.1663, longitude: 75.7885 } },
  { name: 'Hanumangarh', state: 'Rajasthan', coordinates: { latitude: 29.5814, longitude: 74.3294 } },
  { name: 'Beawar', state: 'Rajasthan', coordinates: { latitude: 26.1009, longitude: 74.3189 } },
  { name: 'Kishangarh', state: 'Rajasthan', coordinates: { latitude: 26.5847, longitude: 74.8545 } },

  // Sikkim
  { name: 'Gangtok', state: 'Sikkim', coordinates: { latitude: 27.3389, longitude: 88.6065 } },
  { name: 'Namchi', state: 'Sikkim', coordinates: { latitude: 27.1667, longitude: 88.3500 } },

  // Tamil Nadu
  { name: 'Chennai', state: 'Tamil Nadu', coordinates: { latitude: 13.0827, longitude: 80.2707 } },
  { name: 'Coimbatore', state: 'Tamil Nadu', coordinates: { latitude: 11.0168, longitude: 76.9558 } },
  { name: 'Madurai', state: 'Tamil Nadu', coordinates: { latitude: 9.9252, longitude: 78.1198 } },
  { name: 'Tiruchirappalli', state: 'Tamil Nadu', coordinates: { latitude: 10.7905, longitude: 78.7047 } },
  { name: 'Salem', state: 'Tamil Nadu', coordinates: { latitude: 11.6643, longitude: 78.1460 } },
  { name: 'Tirunelveli', state: 'Tamil Nadu', coordinates: { latitude: 8.7139, longitude: 77.7567 } },
  { name: 'Tiruppur', state: 'Tamil Nadu', coordinates: { latitude: 11.1085, longitude: 77.3411 } },
  { name: 'Erode', state: 'Tamil Nadu', coordinates: { latitude: 11.3410, longitude: 77.7172 } },
  { name: 'Vellore', state: 'Tamil Nadu', coordinates: { latitude: 12.9165, longitude: 79.1325 } },
  { name: 'Thoothukudi', state: 'Tamil Nadu', coordinates: { latitude: 8.7642, longitude: 78.1348 } },
  { name: 'Dindigul', state: 'Tamil Nadu', coordinates: { latitude: 10.3624, longitude: 77.9695 } },
  { name: 'Thanjavur', state: 'Tamil Nadu', coordinates: { latitude: 10.7870, longitude: 79.1378 } },
  { name: 'Ranipet', state: 'Tamil Nadu', coordinates: { latitude: 12.9224, longitude: 79.3326 } },
  { name: 'Sivakasi', state: 'Tamil Nadu', coordinates: { latitude: 9.4533, longitude: 77.7992 } },
  { name: 'Karur', state: 'Tamil Nadu', coordinates: { latitude: 10.9601, longitude: 78.0766 } },
  { name: 'Nagercoil', state: 'Tamil Nadu', coordinates: { latitude: 8.1833, longitude: 77.4119 } },
  { name: 'Kanchipuram', state: 'Tamil Nadu', coordinates: { latitude: 12.8342, longitude: 79.7036 } },
  { name: 'Hosur', state: 'Tamil Nadu', coordinates: { latitude: 12.7409, longitude: 77.8253 } },
  { name: 'Cuddalore', state: 'Tamil Nadu', coordinates: { latitude: 11.7447, longitude: 79.7689 } },
  { name: 'Kumbakonam', state: 'Tamil Nadu', coordinates: { latitude: 10.9602, longitude: 79.3845 } },

  // Telangana
  { name: 'Hyderabad', state: 'Telangana', coordinates: { latitude: 17.3850, longitude: 78.4867 } },
  { name: 'Warangal', state: 'Telangana', coordinates: { latitude: 17.9784, longitude: 79.5941 } },
  { name: 'Nizamabad', state: 'Telangana', coordinates: { latitude: 18.6725, longitude: 78.0941 } },
  { name: 'Karimnagar', state: 'Telangana', coordinates: { latitude: 18.4386, longitude: 79.1288 } },
  { name: 'Khammam', state: 'Telangana', coordinates: { latitude: 17.2473, longitude: 80.1514 } },
  { name: 'Ramagundam', state: 'Telangana', coordinates: { latitude: 18.7639, longitude: 79.4586 } },
  { name: 'Mahbubnagar', state: 'Telangana', coordinates: { latitude: 16.7488, longitude: 77.9853 } },
  { name: 'Nalgonda', state: 'Telangana', coordinates: { latitude: 17.0575, longitude: 79.2690 } },
  { name: 'Adilabad', state: 'Telangana', coordinates: { latitude: 19.6641, longitude: 78.5320 } },
  { name: 'Siddipet', state: 'Telangana', coordinates: { latitude: 18.1018, longitude: 78.8520 } },
  { name: 'Secunderabad', state: 'Telangana', coordinates: { latitude: 17.4399, longitude: 78.4983 } },

  // Tripura
  { name: 'Agartala', state: 'Tripura', coordinates: { latitude: 23.8315, longitude: 91.2868 } },
  { name: 'Dharmanagar', state: 'Tripura', coordinates: { latitude: 24.3670, longitude: 92.1679 } },

  // Uttar Pradesh
  { name: 'Lucknow', state: 'Uttar Pradesh', coordinates: { latitude: 26.8467, longitude: 80.9462 } },
  { name: 'Kanpur', state: 'Uttar Pradesh', coordinates: { latitude: 26.4499, longitude: 80.3319 } },
  { name: 'Agra', state: 'Uttar Pradesh', coordinates: { latitude: 27.1767, longitude: 78.0081 } },
  { name: 'Varanasi', state: 'Uttar Pradesh', coordinates: { latitude: 25.3176, longitude: 82.9739 } },
  { name: 'Meerut', state: 'Uttar Pradesh', coordinates: { latitude: 28.9845, longitude: 77.7064 } },
  { name: 'Prayagraj', state: 'Uttar Pradesh', coordinates: { latitude: 25.4358, longitude: 81.8463 } },
  { name: 'Bareilly', state: 'Uttar Pradesh', coordinates: { latitude: 28.3670, longitude: 79.4304 } },
  { name: 'Aligarh', state: 'Uttar Pradesh', coordinates: { latitude: 27.8974, longitude: 78.0880 } },
  { name: 'Moradabad', state: 'Uttar Pradesh', coordinates: { latitude: 28.8386, longitude: 78.7733 } },
  { name: 'Gorakhpur', state: 'Uttar Pradesh', coordinates: { latitude: 26.7606, longitude: 83.3732 } },
  { name: 'Saharanpur', state: 'Uttar Pradesh', coordinates: { latitude: 29.9680, longitude: 77.5510 } },
  { name: 'Jhansi', state: 'Uttar Pradesh', coordinates: { latitude: 25.4484, longitude: 78.5685 } },
  { name: 'Firozabad', state: 'Uttar Pradesh', coordinates: { latitude: 27.1592, longitude: 78.3957 } },
  { name: 'Muzaffarnagar', state: 'Uttar Pradesh', coordinates: { latitude: 29.4727, longitude: 77.7085 } },
  { name: 'Mathura', state: 'Uttar Pradesh', coordinates: { latitude: 27.4924, longitude: 77.6737 } },
  { name: 'Rampur', state: 'Uttar Pradesh', coordinates: { latitude: 28.7930, longitude: 79.0259 } },
  { name: 'Shahjahanpur', state: 'Uttar Pradesh', coordinates: { latitude: 27.8806, longitude: 79.9106 } },
  { name: 'Farrukhabad', state: 'Uttar Pradesh', coordinates: { latitude: 27.3906, longitude: 79.5800 } },
  { name: 'Ayodhya', state: 'Uttar Pradesh', coordinates: { latitude: 26.7922, longitude: 82.1998 } },
  { name: 'Hapur', state: 'Uttar Pradesh', coordinates: { latitude: 28.7437, longitude: 77.7628 } },
  { name: 'Mirzapur', state: 'Uttar Pradesh', coordinates: { latitude: 25.1337, longitude: 82.5644 } },
  { name: 'Etawah', state: 'Uttar Pradesh', coordinates: { latitude: 26.7856, longitude: 79.0158 } },
  { name: 'Sultanpur', state: 'Uttar Pradesh', coordinates: { latitude: 26.2648, longitude: 82.0727 } },
  { name: 'Sambhal', state: 'Uttar Pradesh', coordinates: { latitude: 28.5904, longitude: 78.5718 } },
  { name: 'Bulandshahr', state: 'Uttar Pradesh', coordinates: { latitude: 28.4070, longitude: 77.8498 } },
  { name: 'Fatehpur', state: 'Uttar Pradesh', coordinates: { latitude: 25.9304, longitude: 80.8139 } },
  { name: 'Jaunpur', state: 'Uttar Pradesh', coordinates: { latitude: 25.7464, longitude: 82.6836 } },
  { name: 'Hardoi', state: 'Uttar Pradesh', coordinates: { latitude: 27.3953, longitude: 80.1311 } },
  { name: 'Lakhimpur', state: 'Uttar Pradesh', coordinates: { latitude: 27.9470, longitude: 80.7727 } },
  { name: 'Unnao', state: 'Uttar Pradesh', coordinates: { latitude: 26.5393, longitude: 80.4878 } },
  { name: 'Sitapur', state: 'Uttar Pradesh', coordinates: { latitude: 27.5726, longitude: 80.6828 } },
  { name: 'Basti', state: 'Uttar Pradesh', coordinates: { latitude: 26.8015, longitude: 82.7464 } },
  { name: 'Azamgarh', state: 'Uttar Pradesh', coordinates: { latitude: 26.0693, longitude: 83.1859 } },
  { name: 'Ballia', state: 'Uttar Pradesh', coordinates: { latitude: 25.7584, longitude: 84.1483 } },
  { name: 'Gonda', state: 'Uttar Pradesh', coordinates: { latitude: 27.1339, longitude: 81.9619 } },
  { name: 'Deoria', state: 'Uttar Pradesh', coordinates: { latitude: 26.5024, longitude: 83.7791 } },
  { name: 'Banda', state: 'Uttar Pradesh', coordinates: { latitude: 25.4751, longitude: 80.3359 } },

  // Uttarakhand
  { name: 'Dehradun', state: 'Uttarakhand', coordinates: { latitude: 30.3165, longitude: 78.0322 } },
  { name: 'Haridwar', state: 'Uttarakhand', coordinates: { latitude: 29.9457, longitude: 78.1642 } },
  { name: 'Roorkee', state: 'Uttarakhand', coordinates: { latitude: 29.8543, longitude: 77.8880 } },
  { name: 'Haldwani', state: 'Uttarakhand', coordinates: { latitude: 29.2232, longitude: 79.5130 } },
  { name: 'Rudrapur', state: 'Uttarakhand', coordinates: { latitude: 28.9757, longitude: 79.3993 } },
  { name: 'Kashipur', state: 'Uttarakhand', coordinates: { latitude: 29.2104, longitude: 78.9619 } },
  { name: 'Rishikesh', state: 'Uttarakhand', coordinates: { latitude: 30.0869, longitude: 78.2676 } },
  { name: 'Nainital', state: 'Uttarakhand', coordinates: { latitude: 29.3919, longitude: 79.4542 } },
  { name: 'Mussoorie', state: 'Uttarakhand', coordinates: { latitude: 30.4598, longitude: 78.0644 } },

  // West Bengal
  { name: 'Kolkata', state: 'West Bengal', coordinates: { latitude: 22.5726, longitude: 88.3639 } },
  { name: 'Howrah', state: 'West Bengal', coordinates: { latitude: 22.5958, longitude: 88.2636 } },
  { name: 'Durgapur', state: 'West Bengal', coordinates: { latitude: 23.5204, longitude: 87.3119 } },
  { name: 'Asansol', state: 'West Bengal', coordinates: { latitude: 23.6739, longitude: 86.9524 } },
  { name: 'Siliguri', state: 'West Bengal', coordinates: { latitude: 26.7271, longitude: 88.6393 } },
  { name: 'Bardhaman', state: 'West Bengal', coordinates: { latitude: 23.2324, longitude: 87.8615 } },
  { name: 'Malda', state: 'West Bengal', coordinates: { latitude: 25.0108, longitude: 88.1411 } },
  { name: 'Baharampur', state: 'West Bengal', coordinates: { latitude: 24.1052, longitude: 88.2506 } },
  { name: 'Habra', state: 'West Bengal', coordinates: { latitude: 22.8422, longitude: 88.6346 } },
  { name: 'Kharagpur', state: 'West Bengal', coordinates: { latitude: 22.3460, longitude: 87.2320 } },
  { name: 'Shantipur', state: 'West Bengal', coordinates: { latitude: 23.2531, longitude: 88.4356 } },
  { name: 'Barrackpore', state: 'West Bengal', coordinates: { latitude: 22.7658, longitude: 88.3768 } },
  { name: 'Darjeeling', state: 'West Bengal', coordinates: { latitude: 27.0410, longitude: 88.2663 } },
  { name: 'Jalpaiguri', state: 'West Bengal', coordinates: { latitude: 26.5167, longitude: 88.7333 } },
  { name: 'Cooch Behar', state: 'West Bengal', coordinates: { latitude: 26.3452, longitude: 89.4482 } },
  { name: 'Haldia', state: 'West Bengal', coordinates: { latitude: 22.0667, longitude: 88.0698 } },
  { name: 'Krishnanagar', state: 'West Bengal', coordinates: { latitude: 23.4013, longitude: 88.4863 } },
  { name: 'Raiganj', state: 'West Bengal', coordinates: { latitude: 25.6167, longitude: 88.1333 } },
  { name: 'Balurghat', state: 'West Bengal', coordinates: { latitude: 25.2167, longitude: 88.7667 } },
  { name: 'Bankura', state: 'West Bengal', coordinates: { latitude: 23.2324, longitude: 87.0746 } },

  // Union Territories
  { name: 'Port Blair', state: 'Andaman and Nicobar Islands', coordinates: { latitude: 11.6234, longitude: 92.7265 } },
  { name: 'Daman', state: 'Dadra and Nagar Haveli and Daman and Diu', coordinates: { latitude: 20.3974, longitude: 72.8328 } },
  { name: 'Silvassa', state: 'Dadra and Nagar Haveli and Daman and Diu', coordinates: { latitude: 20.2766, longitude: 73.0169 } },
  { name: 'Diu', state: 'Dadra and Nagar Haveli and Daman and Diu', coordinates: { latitude: 20.7141, longitude: 70.9874 } },
  { name: 'Kavaratti', state: 'Lakshadweep', coordinates: { latitude: 10.5626, longitude: 72.6369 } },
  { name: 'Puducherry', state: 'Puducherry', coordinates: { latitude: 11.9416, longitude: 79.8083 } },
  { name: 'Karaikal', state: 'Puducherry', coordinates: { latitude: 10.9254, longitude: 79.8380 } },
  { name: 'Jammu', state: 'Jammu and Kashmir', coordinates: { latitude: 32.7266, longitude: 74.8570 } },
  { name: 'Srinagar', state: 'Jammu and Kashmir', coordinates: { latitude: 34.0837, longitude: 74.7973 } },
  { name: 'Anantnag', state: 'Jammu and Kashmir', coordinates: { latitude: 33.7311, longitude: 75.1487 } },
  { name: 'Baramulla', state: 'Jammu and Kashmir', coordinates: { latitude: 34.1980, longitude: 74.3636 } },
  { name: 'Leh', state: 'Ladakh', coordinates: { latitude: 34.1526, longitude: 77.5771 } },
];

async function seedRegions() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Clear existing regions
    await Region.deleteMany({});
    console.log('🗑️  Cleared existing regions');

    // Add slug to each city
    const citiesWithSlug = indianCities.map(city => ({
      ...city,
      slug: createSlug(city.name, city.state),
      country: 'India',
      status: 'ACTIVE'
    }));

    // Insert all cities
    const result = await Region.insertMany(citiesWithSlug);
    console.log(`✅ Successfully seeded ${result.length} Indian cities!`);

    // Show state-wise count
    const states = [...new Set(indianCities.map(c => c.state))];
    console.log(`\n📊 State-wise breakdown:`);
    for (const state of states.sort()) {
      const count = indianCities.filter(c => c.state === state).length;
      console.log(`   ${state}: ${count} cities`);
    }

  } catch (error) {
    console.error('❌ Error seeding regions:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

seedRegions();
